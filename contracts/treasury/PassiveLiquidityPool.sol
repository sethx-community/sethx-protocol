// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AccountRegistry } from "../accounts/AccountRegistry.sol";

interface IFuturesPoolView {
    struct MarketConfig {
        string ticker;
        address oracle;
        uint8 oraclePriceDecimals;
        uint8 marginDecimals;
        uint256 initialMarginBps;
        uint256 maintenanceMarginBps;
        uint256 multiplier;
        uint256 lastSettlementPrice;
        uint256 lastSettlementBlock;
        uint256 minMarginPerUnitLongNorm;
        uint256 minMarginPerUnitShortNorm;
    }

    struct Position {
        uint256 size;
        uint256 margin;
        uint256 marginPerUnitNorm;
        bool isActive;
    }

    function getMarket(bytes32 marketKey) external view returns (MarketConfig memory);

    function getPosition(
        address user,
        bytes32 marketKey,
        bool isLong
    ) external view returns (Position memory);
}

interface ISethxVaultPoolView {
    struct EthBalancesView {
        uint256 freeEth;
        uint256 reservedOrderEth;
    }

    function depositETH() external payable;
    function withdrawETHTo(address to, uint256 amount) external;
    function getETHBalance(address account) external view returns (uint256);
    function getLockedETHBalance(address account) external view returns (uint256);
    function getEthBalances(address account) external view returns (EthBalancesView memory);
}

contract PassiveLiquidityPool is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    struct WithdrawalRequest {
        uint256 shares;
        uint256 requestedAt;
    }

    struct PoolSnapshot {
        bytes32 marketKey;
        string ticker;
        uint256 totalShares;
        uint256 totalPendingWithdrawalShares;
        uint256 totalEthBalance;
        uint256 lockedEthBalance;
        uint256 freeEthBalance;
        uint256 longSize;
        uint256 longMargin;
        uint256 shortSize;
        uint256 shortMargin;
        bool registeredAccount;
        bool active;
        bool depositsPaused;
        bool withdrawalsPaused;
    }

    IFuturesPoolView public immutable futures;
    ISethxVaultPoolView public immutable vault;
    AccountRegistry public immutable accountRegistry;

    bytes32 public immutable marketKey;
    string public marketTicker;

    bool public active = true;
    bool public depositsPaused;
    bool public withdrawalsPaused;

    uint256 public totalShares;
    uint256 public totalPendingWithdrawalShares;

    mapping(address => uint256) public userShares;
    mapping(address => WithdrawalRequest) public withdrawalRequests;

    event Deposited(address indexed user, uint256 assets, uint256 sharesMinted);
    event WithdrawalRequested(address indexed user, uint256 shares);
    event WithdrawalCancelled(address indexed user, uint256 sharesReturned);
    event WithdrawalProcessed(address indexed user, uint256 sharesBurned, uint256 assetsOut);

    event ActiveSet(bool enabled);
    event DepositsPausedSet(bool paused);
    event WithdrawalsPausedSet(bool paused);

    error ZeroAmount();
    error UnknownMarket();
    error PoolInactive();
    error DepositsPausedErr();
    error WithdrawalsPausedErr();
    error InsufficientShares();
    error NoPendingWithdrawal();
    error NothingWithdrawable();
    error PoolNotRegisteredAccount();
    error ZeroAddress();
    error ZeroShares();
    error FreeCollateralMismatch();
    error InvalidMarketKey();

    constructor(
        address futures_,
        address vault_,
        address accountRegistry_,
        bytes32 marketKey_,
        address governor,
        address admin
    ) {
        if (futures_ == address(0)) revert ZeroAddress();
        if (vault_ == address(0)) revert ZeroAddress();
        if (accountRegistry_ == address(0)) revert ZeroAddress();
        if (governor == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (marketKey_ == bytes32(0)) revert InvalidMarketKey();

        futures = IFuturesPoolView(futures_);
        vault = ISethxVaultPoolView(vault_);
        accountRegistry = AccountRegistry(accountRegistry_);
        marketKey = marketKey_;

        IFuturesPoolView.MarketConfig memory m = futures.getMarket(marketKey_);
        if (m.oracle == address(0)) revert UnknownMarket();

        marketTicker = m.ticker;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, governor);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    receive() external payable {}

    function deposit() external payable nonReentrant returns (uint256 sharesMinted) {
        if (!active) revert PoolInactive();
        if (depositsPaused) revert DepositsPausedErr();
        if (msg.value == 0) revert ZeroAmount();
        if (!isRegisteredAccount()) revert PoolNotRegisteredAccount();

        uint256 equityBefore = _equity();

        sharesMinted = _convertToShares(msg.value, equityBefore, totalShares, true);
        if (sharesMinted == 0) revert ZeroShares();

        vault.depositETH{ value: msg.value }();

        totalShares += sharesMinted;
        userShares[msg.sender] += sharesMinted;

        emit Deposited(msg.sender, msg.value, sharesMinted);
    }

    function requestWithdrawal(uint256 shares) external nonReentrant {
        if (withdrawalsPaused) revert WithdrawalsPausedErr();
        if (shares == 0) revert ZeroAmount();
        if (userShares[msg.sender] < shares) revert InsufficientShares();

        userShares[msg.sender] -= shares;

        WithdrawalRequest storage req = withdrawalRequests[msg.sender];
        req.shares += shares;

        if (req.requestedAt == 0) {
            req.requestedAt = block.timestamp;
        }

        totalPendingWithdrawalShares += shares;

        emit WithdrawalRequested(msg.sender, shares);
    }

    function cancelWithdrawalRequest() external nonReentrant {
        WithdrawalRequest storage req = withdrawalRequests[msg.sender];

        uint256 shares = req.shares;
        if (shares == 0) revert NoPendingWithdrawal();

        delete withdrawalRequests[msg.sender];

        totalPendingWithdrawalShares -= shares;
        userShares[msg.sender] += shares;

        emit WithdrawalCancelled(msg.sender, shares);
    }

    function processWithdrawal(address user) external nonReentrant returns (uint256 assetsOut) {
        if (withdrawalsPaused) revert WithdrawalsPausedErr();
        if (!isRegisteredAccount()) revert PoolNotRegisteredAccount();

        WithdrawalRequest storage req = withdrawalRequests[user];

        uint256 pendingShares = req.shares;
        if (pendingShares == 0) revert NoPendingWithdrawal();

        uint256 equityNow = _equity();
        uint256 freeNow = _freeCollateral();

        if (equityNow == 0 || freeNow == 0 || totalShares == 0) {
            revert NothingWithdrawable();
        }

        uint256 maxProcessableShares = (freeNow * totalShares) / equityNow;

        uint256 sharesToBurn =
            pendingShares < maxProcessableShares ? pendingShares : maxProcessableShares;

        if (sharesToBurn == 0) revert NothingWithdrawable();

        assetsOut = (sharesToBurn * equityNow) / totalShares;
        if (assetsOut > freeNow) revert FreeCollateralMismatch();

        totalShares -= sharesToBurn;
        totalPendingWithdrawalShares -= sharesToBurn;

        req.shares = pendingShares - sharesToBurn;

        if (req.shares == 0) {
            delete withdrawalRequests[user];
        }

        vault.withdrawETHTo(user, assetsOut);

        emit WithdrawalProcessed(user, sharesToBurn, assetsOut);
    }

    function setActive(bool enabled) external onlyRole(GOVERNOR_ROLE) {
        active = enabled;

        if (!enabled) {
            depositsPaused = true;
        }

        emit ActiveSet(enabled);
    }

    function setDepositsPaused(bool paused) external onlyRole(GOVERNOR_ROLE) {
        depositsPaused = paused;

        emit DepositsPausedSet(paused);
    }

    function setWithdrawalsPaused(bool paused) external onlyRole(GOVERNOR_ROLE) {
        withdrawalsPaused = paused;

        emit WithdrawalsPausedSet(paused);
    }

    function isRegisteredAccount() public view returns (bool) {
        return accountRegistry.isAccount(address(this));
    }

    function equity() external view returns (uint256) {
        return _equity();
    }

    function freeCollateral() external view returns (uint256) {
        return _freeCollateral();
    }

    function previewDeposit(uint256 assets) external view returns (uint256 sharesOut) {
        sharesOut = _convertToShares(assets, _equity(), totalShares, true);
    }

    function previewRedeem(uint256 shares) external view returns (uint256 assetsOut) {
        assetsOut = _convertToAssets(shares, _equity(), totalShares);
    }

    function pendingWithdrawal(
        address user
    )
        external
        view
        returns (uint256 sharesPending, uint256 assetsAtCurrentNav, uint256 maxAssetsProcessableNow)
    {
        sharesPending = withdrawalRequests[user].shares;

        if (sharesPending == 0 || totalShares == 0) {
            return (sharesPending, 0, 0);
        }

        uint256 equityNow = _equity();
        uint256 freeNow = _freeCollateral();

        assetsAtCurrentNav = _convertToAssets(sharesPending, equityNow, totalShares);

        uint256 maxSharesNow = equityNow == 0 ? 0 : (freeNow * totalShares) / equityNow;
        uint256 sharesNow = sharesPending < maxSharesNow ? sharesPending : maxSharesNow;

        maxAssetsProcessableNow = _convertToAssets(sharesNow, equityNow, totalShares);
    }

    function getSnapshot() external view returns (PoolSnapshot memory snap) {
        IFuturesPoolView.Position memory longPos = futures.getPosition(
            address(this),
            marketKey,
            true
        );

        IFuturesPoolView.Position memory shortPos = futures.getPosition(
            address(this),
            marketKey,
            false
        );

        ISethxVaultPoolView.EthBalancesView memory ethView = vault.getEthBalances(address(this));

        snap.marketKey = marketKey;
        snap.ticker = marketTicker;
        snap.totalShares = totalShares;
        snap.totalPendingWithdrawalShares = totalPendingWithdrawalShares;
        snap.totalEthBalance = ethView.freeEth + ethView.reservedOrderEth;
        snap.lockedEthBalance = ethView.reservedOrderEth;
        snap.freeEthBalance = ethView.freeEth;
        snap.longSize = longPos.size;
        snap.longMargin = longPos.margin;
        snap.shortSize = shortPos.size;
        snap.shortMargin = shortPos.margin;
        snap.registeredAccount = isRegisteredAccount();
        snap.active = active;
        snap.depositsPaused = depositsPaused;
        snap.withdrawalsPaused = withdrawalsPaused;
    }

    function _equity() internal view returns (uint256) {
        return vault.getETHBalance(address(this));
    }

    function _freeCollateral() internal view returns (uint256) {
        return vault.getEthBalances(address(this)).freeEth;
    }

    function _convertToShares(
        uint256 assets,
        uint256 currentEquity,
        uint256 currentSupply,
        bool roundDown
    ) internal pure returns (uint256) {
        if (assets == 0) return 0;
        if (currentSupply == 0 || currentEquity == 0) return assets;

        uint256 shares = (assets * currentSupply) / currentEquity;

        if (!roundDown && (shares * currentEquity) / currentSupply < assets) {
            shares += 1;
        }

        return shares;
    }

    function _convertToAssets(
        uint256 shares,
        uint256 currentEquity,
        uint256 currentSupply
    ) internal pure returns (uint256) {
        if (shares == 0 || currentSupply == 0 || currentEquity == 0) return 0;

        return (shares * currentEquity) / currentSupply;
    }
}
