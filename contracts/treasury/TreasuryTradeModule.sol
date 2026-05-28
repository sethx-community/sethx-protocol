// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { TreasuryModuleBase } from "./TreasuryModuleBase.sol";
import { ProtocolTreasury } from "./ProtocolTreasury.sol";

import { AccountFactory } from "../accounts/AccountFactory.sol";
import { AccountRegistry } from "../accounts/AccountRegistry.sol";
import { Account } from "../accounts/Account.sol";

import { SethxVault } from "../vault/SethxVault.sol";

import { TokenSpotOrderBook } from "../markets/spot/TokenSpotOrderBook.sol";

interface IPassiveLiquidityPool {
    function deposit() external payable returns (uint256 sharesMinted);
    function requestWithdrawal(uint256 shares) external;
    function cancelWithdrawalRequest() external;
    function processWithdrawal(address recipient) external returns (uint256 assetsOut);
    function userShares(address user) external view returns (uint256);
    function withdrawalRequests(
        address user
    ) external view returns (uint256 shares, uint256 requestedAt);
}

/**
 * @title TreasuryTradeModule
 * @notice Treasury-owned execution module for account-based market activity.
 *
 * This version adds:
 * - governor-controlled per-treasurer action permissions
 * - governor-controlled per-treasurer per-account access
 *
 * Lending and passive-liquidity functions can be added later on top of the same framework.
 */
contract TreasuryTradeModule is TreasuryModuleBase {
    using SafeERC20 for IERC20;

    uint256 public constant ACTION_FUND_ACCOUNT = 1 << 0;
    uint256 public constant ACTION_WITHDRAW_ACCOUNT = 1 << 1;
    uint256 public constant ACTION_SPOT_TRADE = 1 << 2;
    uint256 public constant ACTION_LEND = 1 << 3;
    uint256 public constant ACTION_PASSIVE_LP = 1 << 4;

    ProtocolTreasury public immutable protocolTreasury;
    AccountFactory public immutable accountFactory;
    AccountRegistry public immutable accountRegistry;
    SethxVault public immutable vault;

    modifier onlyTradingOrLiquidityTreasurer() {
        bool tradingAllowed = authority.canCallAsTreasurer(
            msg.sender,
            authority.PERMISSION_TRADE_SETHX()
        );

        bool liquidityAllowed = authority.canCallAsTreasurer(
            msg.sender,
            authority.PERMISSION_MANAGE_LIQUIDITY()
        );

        if (!tradingAllowed && !liquidityAllowed) revert Unauthorized();
        _;
    }

    mapping(address => uint256) public treasurerActionPermissions;
    mapping(address => mapping(address => bool)) public treasurerAccountAccess;

    mapping(address => bool) public approvedPassivePools;
    mapping(address => mapping(address => bool)) public treasurerPassivePoolAccess;

    event TreasurerActionPermissionsUpdated(address indexed treasurer, uint256 permissions);
    event TreasurerAccountAccessUpdated(
        address indexed treasurer,
        address indexed account,
        bool allowed
    );

    event TreasuryAccountOpened(address indexed account);

    event TreasuryAccountETHFunded(
        address indexed treasurer,
        address indexed account,
        uint256 amount
    );

    event TreasuryAccountERC20Funded(
        address indexed treasurer,
        address indexed account,
        address indexed token,
        uint256 amount
    );

    event TreasuryAccountETHWithdrawn(
        address indexed treasurer,
        address indexed account,
        uint256 amount
    );

    event TreasuryAccountERC20Withdrawn(
        address indexed treasurer,
        address indexed account,
        address indexed token,
        uint256 amount
    );

    event SpotOrderPlaced(
        address indexed treasurer,
        address indexed account,
        address indexed orderBook,
        address feeToken,
        address baseToken,
        address quoteToken,
        TokenSpotOrderBook.Side side,
        uint256 price,
        uint256 amount,
        uint256 expiry
    );

    event SpotOrderCancelled(
        address indexed treasurer,
        address indexed account,
        address indexed orderBook,
        uint256 orderId
    );

    event LendOrderPlaced(
        address indexed treasurer,
        address indexed account,
        address indexed lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry
    );

    event LendOrderCancelled(
        address indexed treasurer,
        address indexed account,
        address indexed lendingOrderBook,
        uint256 orderId
    );

    event LendingBondInitialRedeemed(
        address indexed treasurer,
        address indexed account,
        address indexed lendingContract,
        uint256 bondIndex
    );

    event LendingBondSupplementalClaimed(
        address indexed treasurer,
        address indexed account,
        address indexed lendingContract,
        uint256 bondIndex
    );

    event PassivePoolApproved(address indexed pool, bool allowed);

    event TreasurerPassivePoolAccessUpdated(
        address indexed treasurer,
        address indexed pool,
        bool allowed
    );

    event PassivePoolDeposited(
        address indexed treasurer,
        address indexed pool,
        uint256 assetsIn,
        uint256 sharesMinted
    );

    event PassivePoolWithdrawalRequested(
        address indexed treasurer,
        address indexed pool,
        uint256 shares
    );

    event PassivePoolWithdrawalCancelled(address indexed treasurer, address indexed pool);

    event PassivePoolWithdrawalProcessed(
        address indexed treasurer,
        address indexed pool,
        uint256 assetsOut
    );

    error InvalidAmount();
    error AccountCreationFailed();
    error AccountNotRegistered();
    error UnknownTreasuryAccount();
    error UnauthorizedModuleAction();
    error UnauthorizedAccountAccess();
    error InvalidPermissions();
    error PassivePoolNotApproved();
    error UnauthorizedPassivePoolAccess();
    error EthOnly();
    error WithdrawalMismatch();
    error EthTransferFailed();
    error NothingReceived();

    constructor(
        address authority_,
        address protocolTreasury_,
        address accountFactory_,
        address accountRegistry_,
        address vault_
    ) TreasuryModuleBase(authority_) {
        if (
            protocolTreasury_ == address(0) ||
            accountFactory_ == address(0) ||
            accountRegistry_ == address(0) ||
            vault_ == address(0)
        ) revert InvalidAddress();

        protocolTreasury = ProtocolTreasury(payable(protocolTreasury_));
        accountFactory = AccountFactory(accountFactory_);
        accountRegistry = AccountRegistry(accountRegistry_);
        vault = SethxVault(vault_);
    }

    receive() external payable {}

    // -------------------------------------------------------------------------
    // Governor controls
    // -------------------------------------------------------------------------

    function setTreasurerActionPermissions(
        address treasurer,
        uint256 permissions
    ) external onlyGovernor {
        if (treasurer == address(0)) revert InvalidAddress();
        _validateActionPermissions(permissions);

        treasurerActionPermissions[treasurer] = permissions;
        emit TreasurerActionPermissionsUpdated(treasurer, permissions);
    }

    function setTreasurerAccountAccess(
        address treasurer,
        address account,
        bool allowed
    ) external onlyGovernor {
        if (treasurer == address(0) || account == address(0)) revert InvalidAddress();
        if (!_isTreasuryAccount(account)) revert UnknownTreasuryAccount();

        treasurerAccountAccess[treasurer][account] = allowed;
        emit TreasurerAccountAccessUpdated(treasurer, account, allowed);
    }

    function setTreasurerAccountAccessBatch(
        address treasurer,
        address[] calldata accounts,
        bool allowed
    ) external onlyGovernor {
        if (treasurer == address(0)) revert InvalidAddress();

        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) revert InvalidAddress();
            if (!_isTreasuryAccount(accounts[i])) revert UnknownTreasuryAccount();

            treasurerAccountAccess[treasurer][accounts[i]] = allowed;
            emit TreasurerAccountAccessUpdated(treasurer, accounts[i], allowed);
        }
    }

    function openTreasuryAccount() external onlyGovernor returns (address account) {
        account = accountFactory.createAccount();
        if (account == address(0)) revert AccountCreationFailed();
        if (!accountRegistry.isAccount(account)) revert AccountNotRegistered();

        emit TreasuryAccountOpened(account);
    }

    function setApprovedPassivePool(address pool, bool allowed) external onlyGovernor {
        if (pool == address(0)) revert InvalidAddress();

        approvedPassivePools[pool] = allowed;
        emit PassivePoolApproved(pool, allowed);
    }

    function setTreasurerPassivePoolAccess(
        address treasurer,
        address pool,
        bool allowed
    ) external onlyGovernor {
        if (treasurer == address(0) || pool == address(0)) revert InvalidAddress();
        if (!approvedPassivePools[pool]) revert PassivePoolNotApproved();

        treasurerPassivePoolAccess[treasurer][pool] = allowed;
        emit TreasurerPassivePoolAccessUpdated(treasurer, pool, allowed);
    }

    function setTreasurerPassivePoolAccessBatch(
        address treasurer,
        address[] calldata pools,
        bool allowed
    ) external onlyGovernor {
        if (treasurer == address(0)) revert InvalidAddress();

        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i] == address(0)) revert InvalidAddress();
            if (!approvedPassivePools[pools[i]]) revert PassivePoolNotApproved();

            treasurerPassivePoolAccess[treasurer][pools[i]] = allowed;
            emit TreasurerPassivePoolAccessUpdated(treasurer, pools[i], allowed);
        }
    }
    // -------------------------------------------------------------------------
    // Account funding / withdrawals
    // -------------------------------------------------------------------------

    function depositETHToAccount(
        address account,
        uint256 amount
    ) external onlyTradingOrLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_FUND_ACCOUNT);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (amount == 0) revert InvalidAmount();

        protocolTreasury.fundInternalETH(payable(address(this)), amount);
        Account(payable(account)).depositETH{ value: amount }();

        emit TreasuryAccountETHFunded(msg.sender, account, amount);
    }

    function depositERC20ToAccount(
        address account,
        address token,
        uint256 amount
    ) external onlyTradingOrLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_FUND_ACCOUNT);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        protocolTreasury.fundInternalERC20(token, address(this), amount);

        IERC20(token).forceApprove(account, 0);
        IERC20(token).forceApprove(account, amount);

        Account(payable(account)).depositToken(token, amount);

        emit TreasuryAccountERC20Funded(msg.sender, account, token, amount);
    }

    function withdrawETHFromAccount(
        address account,
        uint256 amount
    ) external onlyTradingOrLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_WITHDRAW_ACCOUNT);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (amount == 0) revert InvalidAmount();

        uint256 beforeBal = address(this).balance;
        Account(payable(account)).withdrawETH(amount);
        uint256 received = address(this).balance - beforeBal;

        (bool success, ) = payable(address(protocolTreasury)).call{ value: received }("");
        if (!success) revert EthTransferFailed();

        emit TreasuryAccountETHWithdrawn(msg.sender, account, received);
    }

    function withdrawERC20FromAccount(
        address account,
        address token,
        uint256 amount
    ) external onlyTradingOrLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_WITHDRAW_ACCOUNT);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        Account(payable(account)).withdrawToken(token, amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - beforeBal;
        if (received == 0) revert NothingReceived();

        IERC20(token).safeTransfer(address(protocolTreasury), received);

        emit TreasuryAccountERC20Withdrawn(msg.sender, account, token, received);
    }

    // -------------------------------------------------------------------------
    // Spot trading
    // -------------------------------------------------------------------------

    function placeSpotOrder(
        address account,
        address orderBook,
        address feeToken,
        address baseToken,
        address quoteToken,
        TokenSpotOrderBook.Side side,
        uint256 price,
        uint256 amount,
        uint256 expiry
    ) external onlyTradingTreasurer {
        _requireActionPermission(msg.sender, ACTION_SPOT_TRADE);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (orderBook == address(0) || baseToken == address(0) || quoteToken == address(0)) {
            revert InvalidAddress();
        }
        if (price == 0 || amount == 0) revert InvalidAmount();

        Account(payable(account)).placeOrderTokenSpot(
            orderBook,
            feeToken,
            baseToken,
            quoteToken,
            side,
            price,
            amount,
            expiry
        );

        emit SpotOrderPlaced(
            msg.sender,
            account,
            orderBook,
            feeToken,
            baseToken,
            quoteToken,
            side,
            price,
            amount,
            expiry
        );
    }

    function cancelSpotOrder(
        address account,
        address orderBook,
        uint256 orderId
    ) external onlyTradingTreasurer {
        _requireActionPermission(msg.sender, ACTION_SPOT_TRADE);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (orderBook == address(0)) revert InvalidAddress();
        if (orderId == 0) revert InvalidAmount();

        Account(payable(account)).cancelOrderTokenSpot(orderBook, orderId);

        emit SpotOrderCancelled(msg.sender, account, orderBook, orderId);
    }

    // -------------------------------------------------------------------------
    // Lending
    // -------------------------------------------------------------------------

    function placeLendOrder(
        address account,
        address lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry
    ) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_LEND);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (lendingOrderBook == address(0)) revert InvalidAddress();
        if (borrowToken != address(0)) revert EthOnly();
        if (rateBps == 0 || principal == 0) revert InvalidAmount();

        Account(payable(account)).placeLendOrder(
            lendingOrderBook,
            borrowToken,
            marketExpiry,
            riskLevel,
            rateBps,
            principal,
            orderExpiry
        );

        emit LendOrderPlaced(
            msg.sender,
            account,
            lendingOrderBook,
            borrowToken,
            marketExpiry,
            riskLevel,
            rateBps,
            principal,
            orderExpiry
        );
    }

    function cancelLendOrder(
        address account,
        address lendingOrderBook,
        uint256 orderId
    ) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_LEND);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (lendingOrderBook == address(0)) revert InvalidAddress();
        if (orderId == 0) revert InvalidAmount();

        Account(payable(account)).cancelLendOrder(lendingOrderBook, orderId);

        emit LendOrderCancelled(msg.sender, account, lendingOrderBook, orderId);
    }

    function redeemInitialLendingBond(
        address account,
        address lendingContract,
        uint256 bondIndex
    ) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_LEND);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (lendingContract == address(0)) revert InvalidAddress();

        Account(payable(account)).redeemInitialLendingBond(lendingContract, bondIndex);

        emit LendingBondInitialRedeemed(msg.sender, account, lendingContract, bondIndex);
    }

    function claimSupplementalLendingBond(
        address account,
        address lendingContract,
        uint256 bondIndex
    ) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_LEND);
        _requireTreasurerAccountAccess(msg.sender, account);

        if (lendingContract == address(0)) revert InvalidAddress();

        Account(payable(account)).claimSupplementalLendingBond(lendingContract, bondIndex);

        emit LendingBondSupplementalClaimed(msg.sender, account, lendingContract, bondIndex);
    }

    // -------------------------------------------------------------------------
    // Liquidity provision to passive pools
    // -------------------------------------------------------------------------
    function depositToPassivePool(address pool, uint256 amount) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_PASSIVE_LP);
        _requirePassivePoolAccess(msg.sender, pool);

        if (amount == 0) revert InvalidAmount();

        protocolTreasury.fundInternalETH(payable(address(this)), amount);

        uint256 sharesMinted = IPassiveLiquidityPool(payable(pool)).deposit{ value: amount }();

        emit PassivePoolDeposited(msg.sender, pool, amount, sharesMinted);
    }

    function requestPassivePoolWithdrawal(
        address pool,
        uint256 shares
    ) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_PASSIVE_LP);
        _requirePassivePoolAccess(msg.sender, pool);

        if (shares == 0) revert InvalidAmount();

        IPassiveLiquidityPool(payable(pool)).requestWithdrawal(shares);

        emit PassivePoolWithdrawalRequested(msg.sender, pool, shares);
    }

    function cancelPassivePoolWithdrawal(address pool) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_PASSIVE_LP);
        _requirePassivePoolAccess(msg.sender, pool);

        IPassiveLiquidityPool(payable(pool)).cancelWithdrawalRequest();

        emit PassivePoolWithdrawalCancelled(msg.sender, pool);
    }

    function processPassivePoolWithdrawal(address pool) external onlyLiquidityTreasurer {
        _requireActionPermission(msg.sender, ACTION_PASSIVE_LP);
        _requirePassivePoolAccess(msg.sender, pool);

        uint256 beforeBal = address(this).balance;
        uint256 assetsOut = IPassiveLiquidityPool(payable(pool)).processWithdrawal(address(this));
        uint256 received = address(this).balance - beforeBal;

        // sanity: actual ETH received should match return value
        if (received != assetsOut) revert WithdrawalMismatch();

        (bool success, ) = payable(address(protocolTreasury)).call{ value: received }("");
        if (!success) revert EthTransferFailed();

        emit PassivePoolWithdrawalProcessed(msg.sender, pool, received);
    }
    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getTreasuryAccounts() external view returns (address[] memory) {
        return accountRegistry.getAccounts(address(this));
    }

    function treasuryAccountCount() external view returns (uint256) {
        return accountRegistry.accountCount(address(this));
    }

    function latestTreasuryAccount() external view returns (address) {
        return accountRegistry.latestAccount(address(this));
    }

    function isTreasuryAccount(address account) external view returns (bool) {
        return _isTreasuryAccount(account);
    }

    function hasActionPermission(address treasurer, uint256 action) external view returns (bool) {
        return _hasActionPermission(treasurer, action);
    }

    function hasAccountAccess(address treasurer, address account) external view returns (bool) {
        return treasurerAccountAccess[treasurer][account];
    }

    function isRegistryActiveAccount(address account) external view returns (bool) {
        return accountRegistry.isAccount(account) || accountRegistry.isLendingAccount(account);
    }

    function getVaultEthBalance(address account) external view returns (uint256) {
        return vault.getETHBalance(account);
    }

    function getVaultLockedEthBalance(address account) external view returns (uint256) {
        return vault.getLockedETHBalance(account);
    }

    function getVaultTokenBalance(address account, address token) external view returns (uint256) {
        return vault.getERC20Balance(account, token);
    }

    function getVaultLockedTokenBalance(
        address account,
        address token
    ) external view returns (uint256) {
        return vault.getLockedERC20(account, token);
    }
    function getPassivePoolShares(address pool) external view returns (uint256) {
        return IPassiveLiquidityPool(payable(pool)).userShares(address(this));
    }

    function getPassivePoolWithdrawalRequest(
        address pool
    ) external view returns (uint256 shares, uint256 requestedAt) {
        (shares, requestedAt) = IPassiveLiquidityPool(payable(pool)).withdrawalRequests(
            address(this)
        );
    }

    function hasPassivePoolAccess(address treasurer, address pool) external view returns (bool) {
        return treasurerPassivePoolAccess[treasurer][pool];
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _hasActionPermission(address treasurer, uint256 action) internal view returns (bool) {
        return (treasurerActionPermissions[treasurer] & action) != 0;
    }

    function _requireActionPermission(address treasurer, uint256 action) internal view {
        if (!_hasActionPermission(treasurer, action)) revert UnauthorizedModuleAction();
    }

    function _requireTreasurerAccountAccess(address treasurer, address account) internal view {
        if (!_isTreasuryAccount(account)) revert UnknownTreasuryAccount();
        if (!treasurerAccountAccess[treasurer][account]) revert UnauthorizedAccountAccess();
    }

    function _isTreasuryAccount(address account) internal view returns (bool) {
        if (account == address(0)) return false;
        return accountRegistry.isAccountOwner(address(this), account);
    }

    function _validateActionPermissions(uint256 permissions) internal pure {
        uint256 known =
            ACTION_FUND_ACCOUNT |
                ACTION_WITHDRAW_ACCOUNT |
                ACTION_SPOT_TRADE |
                ACTION_LEND |
                ACTION_PASSIVE_LP;

        if ((permissions & ~known) != 0) revert InvalidPermissions();
    }
    function _requirePassivePoolAccess(address treasurer, address pool) internal view {
        if (!approvedPassivePools[pool]) revert PassivePoolNotApproved();
        if (!treasurerPassivePoolAccess[treasurer][pool]) revert UnauthorizedPassivePoolAccess();
    }
}
