// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AccountRegistry } from "../accounts/AccountRegistry.sol";

contract SethxVault is AccessControl, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    uint256 public constant REFERRAL_SHARE_BPS = 3_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant REFERRAL_THRESHOLD_ETH_VALUE = 25 ether;
    uint256 public constant SETHX_PER_ETH = 20_000;

    AccountRegistry public immutable accountRegistry;
    address public immutable sethxToken;

    enum TokenType {
        ERC20,
        ERC721
    }

    // ----- Treasury (accounting only; actual funds sit in this contract)
    uint256 public treasuryEthBalance;
    mapping(address => uint256) public treasuryBalances; // token => amount

    // ----- User balances (internal ledger)
    mapping(address => mapping(address => uint256)) public erc20Balances; // user => token => amount
    mapping(address => uint256) public ethBalances; // user => amount

    // Locks
    mapping(address => mapping(address => uint256)) public erc20Locked;
    mapping(address => uint256) public ethLocked;
    mapping(address => mapping(address => mapping(uint256 => bool))) public erc721Locked;

    // ERC721 tokenId tracking (critical)
    mapping(address => mapping(address => mapping(uint256 => bool))) public erc721Owned; // user => nft => tokenId => bool
    mapping(address => mapping(address => uint256)) public erc721BalanceCount; // user => nft => count

    // ----- Settlement pool (internal, NOT an AccountRegistry account) - per marketKey
    mapping(bytes32 => uint256) public settlementEthLocked;
    mapping(bytes32 => mapping(address => uint256)) public settlementErc20Locked;

    mapping(address => bool) public isERC20;
    mapping(address => bool) public isERC721;

    mapping(address => uint256) public referredFeeEthValue;
    mapping(address => bool) public isApprovedReferrer;

    address[] private erc20Tokens;
    address[] private erc721Tokens;

    // ----- Events
    event Deposited(address indexed account, address token, uint256 amount);
    event Withdrawn(address indexed account, address token, uint256 amount);

    event ETHDeposited(address indexed account, uint256 amount);
    event ETHWithdrawn(address indexed account, uint256 amount);

    event ERC721Deposited(address indexed account, address token, uint256 tokenId);
    event ERC721Withdrawn(address indexed account, address token, uint256 tokenId);
    event ERC721Locked(address indexed account, address indexed nft, uint256 indexed tokenId);
    event ERC721Unlocked(address indexed account, address indexed nft, uint256 indexed tokenId);
    event ERC721Transferred(
        address indexed from,
        address indexed to,
        address indexed nft,
        uint256 tokenId,
        string reason
    );

    event Locked(address indexed account, address token, uint256 amount);
    event Unlocked(address indexed account, address token, uint256 amount);
    event ETHLocked(address indexed account, uint256 amount);
    event ETHUnlocked(address indexed account, uint256 amount);

    event TokenTransferred(
        address indexed from,
        address indexed to,
        address token,
        uint256 amount,
        string reason
    );
    event EthTransferred(address indexed from, address indexed to, uint256 amount, string reason);

    event LockedTokenTransferred(
        address indexed from,
        address indexed to,
        address indexed token,
        uint256 amount,
        string reason
    );

    event LockedETHTransferred(
        address indexed from,
        address indexed to,
        uint256 amount,
        string reason
    );

    event FeeCharged(address indexed account, address token, uint256 amount, string reason);

    event SettlementCollected(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed token,
        uint256 amount,
        string reason
    );
    event SettlementPaid(
        bytes32 indexed marketKey,
        address indexed to,
        address indexed token,
        uint256 amount,
        string reason
    );

    event FuturesSettlementLockedPaid(
        bytes32 indexed marketKey,
        address indexed to,
        uint256 amount,
        string reason
    );

    address public protocolTreasury;

    event ProtocolTreasuryUpdated(address indexed treasury);

    event TreasuryWithdrawnETH(address indexed to, uint256 amount);
    event TreasuryWithdrawnERC20(address indexed token, address indexed to, uint256 amount);

    event ReferralFeeTracked(
        address indexed referrer,
        address indexed payer,
        address indexed token,
        uint256 feeAmount,
        uint256 ethValueAdded,
        uint256 totalEthValue
    );
    event ReferrerApproved(address indexed referrer, uint256 totalEthValue);
    event ReferralFeeShared(
        address indexed referrer,
        address indexed payer,
        address indexed token,
        uint256 grossFee,
        uint256 referralShare,
        uint256 treasuryShare
    );

    // ----- Modifiers
    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }
        _;
    }

    modifier onlyOrderbookOrSettlement() {
        if (!hasRole(ORDERBOOK_ROLE, msg.sender) && !hasRole(SETTLEMENT_ROLE, msg.sender)) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyTreasury() {
        if (!hasRole(TREASURY_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    error ZeroAddress();
    error ZeroAmount();
    error InvalidAccount();
    error InsufficientFreeBalance();
    error InsufficientLockedBalance();
    error EthTransferFailed();
    error UnsupportedToken();
    error NotTokenOwner();
    error Unauthorized();
    error InconsistentBalance();
    error AlreadyDeposited();
    error AlreadyLocked();
    error NotLocked();
    error ProtocolTreasuryNotSet();

    constructor(address registry, address admin, address _sethxToken) {
        if (registry == address(0) || admin == address(0) || _sethxToken == address(0))
            revert ZeroAddress();

        accountRegistry = AccountRegistry(registry);
        sethxToken = _sethxToken;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);

        _setRoleAdmin(ORDERBOOK_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(TREASURY_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(SETTLEMENT_ROLE, GOVERNOR_ROLE);
    }
    // =========================================================
    // ROLE SETTERS
    // =========================================================

    function setOrderbook(address orderbook, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (orderbook == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(ORDERBOOK_ROLE, orderbook);
        } else {
            _revokeRole(ORDERBOOK_ROLE, orderbook);
        }
    }

    function setTreasury(address treasury, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (treasury == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(TREASURY_ROLE, treasury);
        } else {
            _revokeRole(TREASURY_ROLE, treasury);
        }
    }

    function setSettlementManager(
        address settlement,
        bool allowed
    ) external onlyRole(GOVERNOR_ROLE) {
        if (settlement == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(SETTLEMENT_ROLE, settlement);
        } else {
            _revokeRole(SETTLEMENT_ROLE, settlement);
        }
    }

    function setProtocolTreasury(address treasury) external onlyRole(GOVERNOR_ROLE) {
        if (treasury == address(0)) revert ZeroAddress();
        protocolTreasury = treasury;
        emit ProtocolTreasuryUpdated(treasury);
    }

    // =========================================================
    // ETH
    // =========================================================

    function depositETH() external payable onlyAccount {
        if (msg.value == 0) revert ZeroAmount();
        ethBalances[msg.sender] += msg.value;
        emit ETHDeposited(msg.sender, msg.value);
    }

    function withdrawETHTo(address to, uint256 amount) external onlyAccount nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ethBalances[msg.sender] < amount) revert InsufficientFreeBalance();
        if (ethBalances[msg.sender] - ethLocked[msg.sender] < amount) {
            revert InsufficientFreeBalance();
        }

        ethBalances[msg.sender] -= amount;

        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert EthTransferFailed();

        emit ETHWithdrawn(msg.sender, amount);
    }

    function lockETH(address account, uint256 amount) external onlyOrderbookOrSettlement {
        if (amount == 0) revert ZeroAmount();
        if (account == address(0)) revert ZeroAddress();
        if (ethBalances[account] - ethLocked[account] < amount) {
            revert InsufficientFreeBalance();
        }
        ethLocked[account] += amount;
        emit ETHLocked(account, amount);
    }

    function unlockETH(address account, uint256 amount) external onlyOrderbookOrSettlement {
        if (amount == 0) revert ZeroAmount();
        if (account == address(0)) revert ZeroAddress();
        if (ethLocked[account] < amount) revert InsufficientLockedBalance();
        ethLocked[account] -= amount;
        emit ETHUnlocked(account, amount);
    }

    function transferETH(
        address from,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyOrderbookOrSettlement {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ethLocked[from] < amount) revert InsufficientLockedBalance();
        if (ethBalances[from] < amount) revert InsufficientFreeBalance();

        ethLocked[from] -= amount;
        ethBalances[from] -= amount;
        ethBalances[to] += amount;

        emit EthTransferred(from, to, amount, reason);
    }

    function transferLockedETH(
        address from,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyOrderbookOrSettlement {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ethLocked[from] < amount) revert InsufficientLockedBalance();
        if (ethBalances[from] < amount) revert InsufficientFreeBalance();

        ethLocked[from] -= amount;
        ethBalances[from] -= amount;

        ethBalances[to] += amount;
        ethLocked[to] += amount;

        emit LockedETHTransferred(from, to, amount, reason);
    }

    function collectFreeEthToSettlement(
        bytes32 marketKey,
        address from,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ethBalances[from] < amount) revert InsufficientFreeBalance();
        if (ethBalances[from] - ethLocked[from] < amount) {
            revert InsufficientFreeBalance();
        }

        ethBalances[from] -= amount;
        settlementEthLocked[marketKey] += amount;

        emit SettlementCollected(marketKey, from, address(0), amount, reason);
    }

    function transferFreeETH(
        address from,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ethBalances[from] < amount) revert InsufficientFreeBalance();
        if (ethBalances[from] - ethLocked[from] < amount) {
            revert InsufficientFreeBalance();
        }

        ethBalances[from] -= amount;
        ethBalances[to] += amount;

        emit EthTransferred(from, to, amount, reason);
    }

    // =========================================================
    // ERC20
    // =========================================================

    /// @notice Preferred: pull-based deposit (Account holds tokens and approves vault).
    function depositERC20(address token, uint256 amount) external onlyAccount nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _registerToken(token, TokenType.ERC20);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        erc20Balances[msg.sender][token] += amount;

        emit Deposited(msg.sender, token, amount);
    }

    function withdrawERC20To(
        address token,
        address to,
        uint256 amount
    ) external onlyAccount nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (erc20Balances[msg.sender][token] < amount) {
            revert InsufficientFreeBalance();
        }
        if (erc20Balances[msg.sender][token] - erc20Locked[msg.sender][token] < amount) {
            revert InsufficientFreeBalance();
        }

        erc20Balances[msg.sender][token] -= amount;

        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    function lockERC20(
        address account,
        address token,
        uint256 amount
    ) external onlyOrderbookOrSettlement {
        if (account == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (erc20Balances[account][token] - erc20Locked[account][token] < amount) {
            revert InsufficientFreeBalance();
        }

        erc20Locked[account][token] += amount;
        emit Locked(account, token, amount);
    }

    function unlockERC20(
        address account,
        address token,
        uint256 amount
    ) external onlyOrderbookOrSettlement {
        if (account == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (erc20Locked[account][token] < amount) {
            revert InsufficientLockedBalance();
        }

        erc20Locked[account][token] -= amount;
        emit Unlocked(account, token, amount);
    }

    function transferToken(
        address from,
        address to,
        address token,
        uint256 amount,
        string calldata reason
    ) external onlyOrderbookOrSettlement {
        if (from == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (erc20Locked[from][token] < amount) revert InsufficientLockedBalance();
        if (erc20Balances[from][token] < amount) revert InsufficientFreeBalance();

        erc20Locked[from][token] -= amount;
        erc20Balances[from][token] -= amount;
        erc20Balances[to][token] += amount;

        emit TokenTransferred(from, to, token, amount, reason);
    }

    function transferLockedERC20(
        address from,
        address to,
        address token,
        uint256 amount,
        string calldata reason
    ) external onlyOrderbookOrSettlement {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (erc20Locked[from][token] < amount) revert InsufficientLockedBalance();
        if (erc20Balances[from][token] < amount) revert InsufficientFreeBalance();

        erc20Locked[from][token] -= amount;
        erc20Balances[from][token] -= amount;

        erc20Balances[to][token] += amount;
        erc20Locked[to][token] += amount;

        emit LockedTokenTransferred(from, to, token, amount, reason);
    }

    // =========================================================
    // ERC721
    // =========================================================

    /// @notice Preferred pull-based deposit: Account transfers from itself into vault.
    /// @dev This requires the Account to actually own tokenId (usually not your desired UX).
    function depositERC721(address nft, uint256 tokenId) external onlyAccount nonReentrant {
        if (nft == address(0)) revert ZeroAddress();
        _registerToken(nft, TokenType.ERC721);

        if (erc721Owned[msg.sender][nft][tokenId]) revert AlreadyDeposited();

        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        // ownership is guaranteed because transfer just happened
        erc721Owned[msg.sender][nft][tokenId] = true;
        erc721BalanceCount[msg.sender][nft] += 1;

        emit ERC721Deposited(msg.sender, nft, tokenId);
    }

    function withdrawERC721To(
        address nft,
        uint256 tokenId,
        address to
    ) external onlyAccount nonReentrant {
        if (nft == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (!erc721Owned[msg.sender][nft][tokenId]) revert NotTokenOwner();
        if (erc721Locked[msg.sender][nft][tokenId]) revert AlreadyLocked();

        erc721Owned[msg.sender][nft][tokenId] = false;
        erc721BalanceCount[msg.sender][nft] -= 1;

        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        emit ERC721Withdrawn(msg.sender, nft, tokenId);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function lockERC721(
        address account,
        address nft,
        uint256 tokenId
    ) external onlyOrderbookOrSettlement {
        if (account == address(0)) revert ZeroAddress();
        if (nft == address(0)) revert ZeroAddress();
        if (!erc721Owned[account][nft][tokenId]) revert NotTokenOwner();
        if (erc721Locked[account][nft][tokenId]) revert AlreadyLocked();
        erc721Locked[account][nft][tokenId] = true;
        emit ERC721Locked(account, nft, tokenId);
    }

    function unlockERC721(
        address account,
        address nft,
        uint256 tokenId
    ) external onlyOrderbookOrSettlement {
        if (account == address(0)) revert ZeroAddress();
        if (nft == address(0)) revert ZeroAddress();
        if (!erc721Locked[account][nft][tokenId]) revert NotLocked();
        erc721Locked[account][nft][tokenId] = false;
        emit ERC721Unlocked(account, nft, tokenId);
    }

    function transferERC721(
        address from,
        address to,
        address nft,
        uint256 tokenId,
        string calldata reason
    ) external onlyOrderbookOrSettlement {
        if (from == address(0)) revert ZeroAddress();
        if (nft == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (!erc721Owned[from][nft][tokenId]) revert NotTokenOwner();
        if (!erc721Locked[from][nft][tokenId]) revert NotLocked();

        erc721Locked[from][nft][tokenId] = false;
        erc721Owned[from][nft][tokenId] = false;
        erc721BalanceCount[from][nft] -= 1;

        if (erc721Owned[to][nft][tokenId]) revert AlreadyDeposited();
        erc721Owned[to][nft][tokenId] = true;
        erc721BalanceCount[to][nft] += 1;

        emit ERC721Transferred(from, to, nft, tokenId, reason);
    }

    // =========================================================
    // Fees
    // =========================================================

    function chargeFee(
        address account,
        address token,
        uint256 amount,
        string calldata reason,
        address referrer
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bool validReferrer = _isValidReferrer(account, referrer);
        bool approvedBeforeCharge = validReferrer && isApprovedReferrer[referrer];

        if (validReferrer && !approvedBeforeCharge) {
            _trackReferralThreshold(referrer, account, token, amount);
        }

        uint256 referralShare;
        if (approvedBeforeCharge) {
            referralShare = (amount * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR;
        }

        uint256 treasuryShare = amount - referralShare;

        if (token == address(0)) {
            if (ethLocked[account] < amount) revert InsufficientLockedBalance();
            if (ethBalances[account] < amount) revert InsufficientFreeBalance();
            ethLocked[account] -= amount;
            ethBalances[account] -= amount;
            treasuryEthBalance += treasuryShare;
            if (referralShare > 0) ethBalances[referrer] += referralShare;
        } else {
            if (erc20Locked[account][token] < amount) revert InsufficientLockedBalance();
            if (erc20Balances[account][token] < amount) revert InsufficientFreeBalance();
            erc20Locked[account][token] -= amount;
            erc20Balances[account][token] -= amount;
            treasuryBalances[token] += treasuryShare;
            if (referralShare > 0) erc20Balances[referrer][token] += referralShare;
        }

        emit FeeCharged(account, token, amount, reason);
        if (referralShare > 0) {
            emit ReferralFeeShared(referrer, account, token, amount, referralShare, treasuryShare);
        }
    }

    function _isValidReferrer(address payer, address referrer) internal view returns (bool) {
        if (referrer == address(0)) return false;
        if (referrer == payer) return false;
        return accountRegistry.isAccount(referrer);
    }

    function _trackReferralThreshold(
        address referrer,
        address payer,
        address token,
        uint256 amount
    ) internal {
        uint256 ethValue = _referralEthValue(token, amount);
        if (ethValue == 0) return;

        uint256 total = referredFeeEthValue[referrer] + ethValue;
        referredFeeEthValue[referrer] = total;

        emit ReferralFeeTracked(referrer, payer, token, amount, ethValue, total);

        if (total >= REFERRAL_THRESHOLD_ETH_VALUE) {
            isApprovedReferrer[referrer] = true;
            emit ReferrerApproved(referrer, total);
        }
    }

    function _referralEthValue(address token, uint256 amount) internal view returns (uint256) {
        if (token == address(0)) return amount;
        if (token == sethxToken && sethxToken != address(0)) return amount / SETHX_PER_ETH;
        return 0;
    }

    // =========================================================
    // Settlement pool transfers
    // =========================================================

    function collectToSettlement(
        bytes32 marketKey,
        address from,
        address token,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (token == address(0)) {
            if (ethLocked[from] < amount) revert InsufficientLockedBalance();
            if (ethBalances[from] < amount) revert InsufficientFreeBalance();
            ethLocked[from] -= amount;
            ethBalances[from] -= amount;
            settlementEthLocked[marketKey] += amount;
        } else {
            if (erc20Locked[from][token] < amount) revert InsufficientLockedBalance();
            if (erc20Balances[from][token] < amount) revert InsufficientFreeBalance();
            erc20Locked[from][token] -= amount;
            erc20Balances[from][token] -= amount;
            settlementErc20Locked[marketKey][token] += amount;
        }

        emit SettlementCollected(marketKey, from, token, amount, reason);
    }

    /// @dev Settlement payout is intentionally ETH-only.
    /// ERC20 settlement collection exists for market collateral/accounting,
    /// but liquidation payout logic pays settlement proceeds in ETH.
    function payFromSettlement(
        bytes32 marketKey,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (settlementEthLocked[marketKey] < amount) {
            revert InsufficientLockedBalance();
        }

        settlementEthLocked[marketKey] -= amount;
        ethBalances[to] += amount;

        emit SettlementPaid(marketKey, to, address(0), amount, reason);
    }

    function payFromFuturesSettlementLocked(
        bytes32 marketKey,
        address to,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (settlementEthLocked[marketKey] < amount) {
            revert InsufficientLockedBalance();
        }

        settlementEthLocked[marketKey] -= amount;
        ethBalances[to] += amount;
        ethLocked[to] += amount;

        emit FuturesSettlementLockedPaid(marketKey, to, amount, reason);
    }

    // =========================================================
    // Treasury withdrawals (custody moves out of vault)
    // =========================================================

    function withdrawTreasuryETH(uint256 amount) external onlyTreasury nonReentrant {
        if (protocolTreasury == address(0)) revert ProtocolTreasuryNotSet();
        if (amount == 0) revert ZeroAmount();
        if (treasuryEthBalance < amount) revert InsufficientFreeBalance();

        treasuryEthBalance -= amount;

        (bool ok, ) = payable(protocolTreasury).call{ value: amount }("");
        if (!ok) revert EthTransferFailed();

        emit TreasuryWithdrawnETH(protocolTreasury, amount);
    }

    function withdrawTreasuryERC20(
        address token,
        uint256 amount
    ) external onlyTreasury nonReentrant {
        if (protocolTreasury == address(0)) revert ProtocolTreasuryNotSet();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (treasuryBalances[token] < amount) revert InsufficientFreeBalance();

        treasuryBalances[token] -= amount;

        IERC20(token).safeTransfer(protocolTreasury, amount);
        emit TreasuryWithdrawnERC20(token, protocolTreasury, amount);
    }
    // =========================================================
    // Internal token registry (UI only)
    // =========================================================

    function _registerToken(address token, TokenType tokenType) internal {
        if (token == address(0)) revert ZeroAddress();

        if (tokenType == TokenType.ERC20) {
            if (!isERC20[token]) {
                isERC20[token] = true;
                erc20Tokens.push(token);
            }
        } else if (tokenType == TokenType.ERC721) {
            if (!isERC721[token]) {
                isERC721[token] = true;
                erc721Tokens.push(token);
            }
        } else {
            revert UnsupportedToken();
        }
    }

    function getERC20Tokens() external view returns (address[] memory) {
        return erc20Tokens;
    }

    function getERC721Tokens() external view returns (address[] memory) {
        return erc721Tokens;
    }

    function getERC20Balance(address account, address token) external view returns (uint256) {
        return erc20Balances[account][token];
    }

    function getLockedERC20(address account, address token) external view returns (uint256) {
        return erc20Locked[account][token];
    }
    function getETHBalance(address account) external view returns (uint256) {
        return ethBalances[account];
    }
    function getLockedETHBalance(address account) external view returns (uint256) {
        return ethLocked[account];
    }

    // =========================================================
    // VALUATION HELPERS
    // =========================================================

    struct EthBalancesView {
        uint256 freeEth;
        uint256 reservedOrderEth;
    }

    struct Erc20BalanceView {
        address token;
        uint256 freeAmount;
        uint256 reservedOrderAmount;
    }

    /// @notice Returns ETH balances split between free and locked (orders)
    function getEthBalances(address account) external view returns (EthBalancesView memory) {
        uint256 total = ethBalances[account];
        uint256 locked = ethLocked[account];
        if (total < locked) revert InconsistentBalance();

        return EthBalancesView({ freeEth: total - locked, reservedOrderEth: locked });
    }

    /// @notice Returns all ERC20 balances for valuation
    function getErc20Balances(address account) external view returns (Erc20BalanceView[] memory) {
        uint256 len = erc20Tokens.length;
        Erc20BalanceView[] memory balances = new Erc20BalanceView[](len);

        for (uint256 i = 0; i < len; i++) {
            address token = erc20Tokens[i];

            uint256 total = erc20Balances[account][token];
            uint256 locked = erc20Locked[account][token];
            if (total < locked) revert InconsistentBalance();

            balances[i] = Erc20BalanceView({
                token: token,
                freeAmount: total - locked,
                reservedOrderAmount: locked
            });
        }

        return balances;
    }
}
