// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { SethxVault } from "../../vault/SethxVault.sol";

interface ILendingRiskModuleHook {
    function latchAccountRiskLevel(address account, uint16 riskLevel) external;
    function requireAccountRiskLevel(address account, uint16 riskLevel) external view;
    function clearAccountRiskLevel(address account) external;
}

interface ILendingAccountRiskModuleView {
    function riskModule() external view returns (address);
}

contract LendingContract is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");
    bytes32 public constant LOSS_MANAGER_ROLE = keccak256("LOSS_MANAGER_ROLE");
    bytes32 public constant RECOVERY_MANAGER_ROLE = keccak256("RECOVERY_MANAGER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant RAY = 1e27;
    uint256 public constant YEAR = 365 days;

    AccountRegistry public immutable accountRegistry;
    SethxVault public immutable vault;
    ILendingRiskModuleHook public riskModule;

    // -------- Errors --------
    error OrderBookOnly();
    error NotRegisteredAccount();

    error ZeroAddress();
    error DirectETHNotAccepted();
    error UseBorrowerLoss();

    error InvalidRiskLevel();
    error InvalidLtvConfig();
    error InvalidMarket();
    error UnknownMarket();
    error MarketInactive();
    error MarketExpired();
    error MarketAlreadySettled();
    error MarketNotMatured();
    error MarketNotSettled();

    error UnknownBond();
    error NotOwner();
    error AlreadyRedeemed();
    error NothingClaimable();
    error InsufficientMarketLiquidity();
    error BadRecipient();

    error InvalidAmount();
    error CancelExceedsPending();
    error CancelExceedsRollover();
    error MatchedExceedsPending();
    error MatchedExceedsRollover();

    error SameMarketRollover();
    error NoRolloverDebt();
    error NoDebt();
    error LossExceedsBorrowerDebt();
    error ResolvedExceedsFace();
    error AppliedMismatch();

    error BorrowerMustBeLendingAccount();
    error RiskModuleNotSet();
    error OutdatedRiskModule();
    error ExpiryPassed();
    error BondNotInOwnerList();

    // -------- Types --------

    struct MarketSettlement {
        bool primarySettled;
        uint64 settlementTimestamp;
        uint256 initialRecoveryRateRay;
        uint256 supplementalRecoveryPerFaceRay;
        uint256 totalRecoveredAtSettlement;
        uint256 settledTotalFaceValue;
    }

    struct RiskLevelConfig {
        bool enabled;
        uint32 maxLtvBps;
        uint32 liquidationLtvBps;
    }

    struct MarketConfig {
        address borrowToken;
        uint64 expiry;
        uint16 riskLevel;
        uint32 maxLtvBps;
        uint32 liquidationLtvBps;
        bool active;
    }

    struct DebtPosition {
        uint256 principal;
        uint256 faceValue;
    }

    struct BondLot {
        address owner;
        bytes32 marketKey;
        uint256 faceValue;
        bool initialRedeemed;
        uint256 supplementalClaimedPerFaceRay;
    }

    struct MarketTotals {
        // Sum of original matched principal for this market. This is the bondholder
        // issuance base and is intentionally not reduced by repayments.
        uint256 totalPrincipal;
        // Sum of original matched face values for this market. This is the
        // bondholder claim base used for settlement and recovery-rate math.
        uint256 totalFaceValue;
        // Remaining borrower principal outstanding for this market.
        uint256 outstandingPrincipal;
        // Remaining borrower face value outstanding for this market.
        uint256 outstandingFaceValue;
        uint256 cumulativeLosses;
    }

    struct DateParts {
        uint256 year;
        uint256 month;
        uint256 day;
        uint256 hour;
        uint256 minute;
        uint256 second;
        uint256 weekday;
    }

    mapping(uint16 => RiskLevelConfig) public riskLevels;
    mapping(bytes32 => MarketConfig) public markets;
    mapping(bytes32 => bool) public marketExists;
    mapping(address => mapping(bytes32 => DebtPosition)) public debts;
    mapping(address => mapping(bytes32 => uint256)) public pendingBorrowPrincipal;
    // Subset of pendingBorrowPrincipal whose matched proceeds are used immediately
    // to repay old debt. It is tracked only so valuation does not count those
    // proceeds as free collateral while the rollover order is open.
    mapping(address => mapping(bytes32 => uint256)) public pendingRolloverBorrowPrincipal;
    mapping(uint256 => BondLot) public bondLots;
    mapping(address => uint256[]) public userBondLots;
    uint256 public nextBondIndex = 1;
    mapping(bytes32 => MarketTotals) public marketTotals;
    mapping(bytes32 => MarketSettlement) public marketSettlements;
    mapping(bytes32 => uint256) public recoveredBeforeSettlement;

    // Logical market recovery amount. Actual ETH custody stays in SethxVault settlement balances.
    mapping(bytes32 => uint256) public marketEscrowedEth;
    mapping(bytes32 => uint256) public marketClaimedEth;

    mapping(address => bytes32[]) internal borrowerActiveMarkets;
    mapping(address => mapping(bytes32 => bool)) internal borrowerActiveMarketSeen;
    mapping(address => bytes32[]) internal borrowerPendingMarkets;
    mapping(address => mapping(bytes32 => bool)) internal borrowerPendingMarketSeen;

    event RiskLevelSet(
        uint16 indexed riskLevel,
        bool enabled,
        uint32 maxLtvBps,
        uint32 liquidationLtvBps
    );
    event MarketCreated(
        bytes32 indexed marketKey,
        address indexed borrowToken,
        uint64 expiry,
        uint16 riskLevel,
        uint32 maxLtvBps,
        uint32 liquidationLtvBps
    );
    event MarketStatusChanged(bytes32 indexed marketKey, bool active);
    event RiskModuleSet(address indexed oldRiskModule, address indexed newRiskModule);

    event BorrowOrderRegistered(
        address indexed borrower,
        bytes32 indexed marketKey,
        uint256 amount
    );
    event BorrowOrderReleased(address indexed borrower, bytes32 indexed marketKey, uint256 amount);
    event LoanMatched(
        address indexed lender,
        address indexed borrower,
        bytes32 indexed marketKey,
        uint256 principal,
        uint256 faceValue,
        uint256 rateBps,
        uint256 bondIndex
    );

    event MarketLossRecorded(
        address indexed borrower,
        bytes32 indexed marketKey,
        uint256 lossAmount,
        uint256 cumulativeLosses,
        uint256 remainingBorrowerPrincipal,
        uint256 remainingBorrowerFaceValue,
        uint256 remainingOutstandingFaceValue
    );
    event RecoveryRecordedBeforeSettlement(
        bytes32 indexed marketKey,
        uint256 amount,
        uint256 totalRecoveredBeforeSettlement,
        uint256 effectiveCumulativeLosses
    );
    event MarketPrimarySettled(
        bytes32 indexed marketKey,
        uint256 initialRecoveryRateRay,
        uint256 totalRecoveredAtSettlement
    );
    event SupplementalRecoveryRecorded(
        bytes32 indexed marketKey,
        uint256 amount,
        uint256 newSupplementalRecoveryPerFaceRay
    );

    event BondInitialRedeemed(
        uint256 indexed bondIndex,
        address indexed owner,
        bytes32 indexed marketKey,
        uint256 amount
    );
    event BondSupplementalClaimed(
        uint256 indexed bondIndex,
        address indexed owner,
        bytes32 indexed marketKey,
        uint256 amount
    );
    event BondTransferred(uint256 indexed bondIndex, address indexed from, address indexed to);

    event MarketEscrowFunded(bytes32 indexed marketKey, uint256 amount, uint256 newEscrowedEth);
    event MarketEscrowClaimed(bytes32 indexed marketKey, uint256 amount, uint256 newClaimedEth);
    event DebtRepaid(
        address indexed borrower,
        bytes32 indexed marketKey,
        uint256 amountSent,
        uint256 amountApplied,
        uint256 principalReduced,
        uint256 remainingPrincipal,
        uint256 remainingFaceValue
    );

    modifier onlyOrderBook() {
        if (!hasRole(ORDERBOOK_ROLE, msg.sender)) revert OrderBookOnly();
        _;
    }

    modifier onlyAccount(address account) {
        if (!accountRegistry.isAccount(account) && !accountRegistry.isLendingAccount(account))
            revert NotRegisteredAccount();
        _;
    }

    receive() external payable {
        revert DirectETHNotAccepted();
    }

    constructor(address _accountRegistry, address _vault, address admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        accountRegistry = AccountRegistry(_accountRegistry);
        vault = SethxVault(_vault);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(LOSS_MANAGER_ROLE, admin);
        _grantRole(RECOVERY_MANAGER_ROLE, admin);

        _setRoleAdmin(ORDERBOOK_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(LOSS_MANAGER_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(RECOVERY_MANAGER_ROLE, GOVERNOR_ROLE);
    }

    function setRiskLevel(
        uint16 riskLevel,
        bool enabled,
        uint32 maxLtvBps,
        uint32 liquidationLtvBps
    ) external onlyRole(GOVERNOR_ROLE) {
        if (riskLevel == 0) revert InvalidRiskLevel();
        if (maxLtvBps == 0 || maxLtvBps >= liquidationLtvBps) revert InvalidLtvConfig();
        if (liquidationLtvBps > BPS) revert InvalidLtvConfig();
        riskLevels[riskLevel] = RiskLevelConfig(enabled, maxLtvBps, liquidationLtvBps);
        emit RiskLevelSet(riskLevel, enabled, maxLtvBps, liquidationLtvBps);
    }

    function setOrderBook(address orderBook, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (orderBook == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(ORDERBOOK_ROLE, orderBook);
        } else {
            _revokeRole(ORDERBOOK_ROLE, orderBook);
        }
    }

    function setRiskModule(address newRiskModule) external onlyRole(GOVERNOR_ROLE) {
        if (newRiskModule == address(0)) revert ZeroAddress();
        address oldRiskModule = address(riskModule);
        riskModule = ILendingRiskModuleHook(newRiskModule);
        emit RiskModuleSet(oldRiskModule, newRiskModule);
    }

    function setRecoveryManager(address manager, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (manager == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(RECOVERY_MANAGER_ROLE, manager);
        } else {
            _revokeRole(RECOVERY_MANAGER_ROLE, manager);
        }
    }

    function setLossManager(address manager, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (manager == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(LOSS_MANAGER_ROLE, manager);
        } else {
            _revokeRole(LOSS_MANAGER_ROLE, manager);
        }
    }

    function setMarketActive(bytes32 marketKey, bool active) external onlyRole(GOVERNOR_ROLE) {
        if (!marketExists[marketKey]) revert UnknownMarket();
        markets[marketKey].active = active;
        emit MarketStatusChanged(marketKey, active);
    }

    function getMarket(bytes32 marketKey) external view returns (MarketConfig memory) {
        return markets[marketKey];
    }

    function getMarketTotals(bytes32 marketKey) external view returns (MarketTotals memory) {
        return marketTotals[marketKey];
    }

    function getMarketSettlement(
        bytes32 marketKey
    ) external view returns (MarketSettlement memory) {
        return marketSettlements[marketKey];
    }

    function getBondLot(uint256 bondIndex) external view returns (BondLot memory) {
        return bondLots[bondIndex];
    }

    function getDebt(
        address account,
        bytes32 marketKey
    ) external view returns (DebtPosition memory) {
        return debts[account][marketKey];
    }

    function getBorrowerActiveMarkets(address account) external view returns (bytes32[] memory) {
        return borrowerActiveMarkets[account];
    }

    function getBorrowerPendingMarkets(address account) external view returns (bytes32[] memory) {
        return borrowerPendingMarkets[account];
    }

    function getUserBondLots(address account) external view returns (uint256[] memory) {
        return userBondLots[account];
    }

    function accountHasDebt(address account) external view returns (bool) {
        return getAccountTotalDebt(account) > 0;
    }

    function isRestricted(address account) external view returns (bool) {
        return getAccountTotalDebt(account) > 0 || getAccountPendingBorrow(account) > 0;
    }

    function getAccountTotalDebt(address account) public view returns (uint256 totalDebtEth) {
        bytes32[] memory borrowerMarkets = borrowerActiveMarkets[account];
        for (uint256 i = 0; i < borrowerMarkets.length; i++) {
            totalDebtEth += debts[account][borrowerMarkets[i]].faceValue;
        }
    }

    function getAccountPendingBorrow(
        address account
    ) public view returns (uint256 pendingBorrowEth) {
        bytes32[] memory pendingMarkets = borrowerPendingMarkets[account];
        for (uint256 i = 0; i < pendingMarkets.length; i++) {
            bytes32 marketKey = pendingMarkets[i];
            pendingBorrowEth += pendingBorrowPrincipal[account][marketKey];
        }
    }

    function getAccountPendingBorrowProceeds(
        address account
    ) public view returns (uint256 pendingBorrowProceedsEth) {
        bytes32[] memory pendingMarkets = borrowerPendingMarkets[account];
        for (uint256 i = 0; i < pendingMarkets.length; i++) {
            bytes32 marketKey = pendingMarkets[i];
            uint256 pending = pendingBorrowPrincipal[account][marketKey];
            uint256 rollover = pendingRolloverBorrowPrincipal[account][marketKey];
            pendingBorrowProceedsEth += pending > rollover ? pending - rollover : 0;
        }
    }

    function getRecoveryRate(bytes32 marketKey) public view returns (uint256) {
        MarketSettlement memory ms = marketSettlements[marketKey];
        if (ms.primarySettled) {
            uint256 totalRay = ms.initialRecoveryRateRay + ms.supplementalRecoveryPerFaceRay;
            return totalRay > RAY ? RAY : totalRay;
        }

        MarketTotals memory totals = marketTotals[marketKey];
        if (totals.totalFaceValue == 0) return RAY;
        if (totals.cumulativeLosses >= totals.totalFaceValue) return 0;

        return ((totals.totalFaceValue - totals.cumulativeLosses) * RAY) / totals.totalFaceValue;
    }

    function getBondInitialClaimable(uint256 bondIndex) public view returns (uint256) {
        BondLot memory lot = bondLots[bondIndex];
        if (lot.owner == address(0)) revert UnknownBond();

        MarketSettlement memory ms = marketSettlements[lot.marketKey];
        if (!ms.primarySettled || lot.initialRedeemed) return 0;

        return _mulDivDown(lot.faceValue, ms.initialRecoveryRateRay, RAY);
    }

    function getBondSupplementalClaimable(uint256 bondIndex) public view returns (uint256) {
        BondLot memory lot = bondLots[bondIndex];
        if (lot.owner == address(0)) revert UnknownBond();

        MarketSettlement memory ms = marketSettlements[lot.marketKey];
        if (!ms.primarySettled) return 0;
        if (ms.supplementalRecoveryPerFaceRay <= lot.supplementalClaimedPerFaceRay) return 0;

        uint256 deltaPerFace =
            ms.supplementalRecoveryPerFaceRay - lot.supplementalClaimedPerFaceRay;
        return _mulDivDown(lot.faceValue, deltaPerFace, RAY);
    }

    function getMarketClaimableLiquidity(bytes32 marketKey) public view returns (uint256) {
        uint256 escrowed = marketEscrowedEth[marketKey];
        uint256 claimed = marketClaimedEth[marketKey];
        return escrowed > claimed ? escrowed - claimed : 0;
    }

    function isValidMarket(
        address borrowToken,
        uint64 expiry,
        uint16 riskLevel
    ) public view returns (bool) {
        if (borrowToken != address(0)) return false; // ETH only for v1
        if (expiry <= block.timestamp) return false;
        if (!_isAllowedExpiry(expiry)) return false;

        RiskLevelConfig memory rl = riskLevels[riskLevel];
        if (!rl.enabled) return false;
        if (rl.maxLtvBps == 0 || rl.maxLtvBps >= rl.liquidationLtvBps) return false;
        if (rl.liquidationLtvBps > BPS) return false;

        return true;
    }

    function ensureMarket(
        address borrowToken,
        uint64 expiry,
        uint16 riskLevel
    ) external onlyOrderBook returns (bytes32 marketKey) {
        if (!isValidMarket(borrowToken, expiry, riskLevel)) revert InvalidMarket();

        marketKey = keccak256(abi.encode(borrowToken, expiry, riskLevel));
        if (!marketExists[marketKey]) {
            RiskLevelConfig memory rl = riskLevels[riskLevel];
            markets[marketKey] = MarketConfig({
                borrowToken: borrowToken,
                expiry: expiry,
                riskLevel: riskLevel,
                maxLtvBps: rl.maxLtvBps,
                liquidationLtvBps: rl.liquidationLtvBps,
                active: true
            });
            marketExists[marketKey] = true;

            emit MarketCreated(
                marketKey,
                borrowToken,
                expiry,
                riskLevel,
                rl.maxLtvBps,
                rl.liquidationLtvBps
            );
        }
    }

    function onBorrowOrderPlaced(
        address borrower,
        bytes32 marketKey,
        uint256 amount
    ) external onlyOrderBook onlyAccount(borrower) {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (!markets[marketKey].active) revert MarketInactive();
        if (markets[marketKey].expiry <= block.timestamp) revert MarketExpired();
        if (marketSettlements[marketKey].primarySettled) revert MarketAlreadySettled();
        if (amount == 0) revert InvalidAmount();
        _requireCurrentBorrowerRiskModule(borrower);
        _latchBorrowerRiskLevel(borrower, marketKey);

        pendingBorrowPrincipal[borrower][marketKey] += amount;

        if (!borrowerPendingMarketSeen[borrower][marketKey]) {
            borrowerPendingMarketSeen[borrower][marketKey] = true;
            borrowerPendingMarkets[borrower].push(marketKey);
        }

        emit BorrowOrderRegistered(borrower, marketKey, amount);
    }

    function onBorrowOrderCancelled(
        address borrower,
        bytes32 marketKey,
        uint256 amount
    ) external onlyOrderBook onlyAccount(borrower) {
        if (amount == 0) revert InvalidAmount();

        uint256 pending = pendingBorrowPrincipal[borrower][marketKey];
        if (pending < amount) revert CancelExceedsPending();

        unchecked {
            pendingBorrowPrincipal[borrower][marketKey] = pending - amount;
        }

        if (pendingBorrowPrincipal[borrower][marketKey] == 0) {
            _removePendingMarketIfZero(borrower, marketKey);
        }
        _clearBorrowerRiskLevelIfFlat(borrower);

        emit BorrowOrderReleased(borrower, marketKey, amount);
    }

    function onRolloverBorrowOrderPlaced(
        address borrower,
        bytes32 newMarketKey,
        uint256 amount,
        bytes32 repayMarketKey
    ) external onlyOrderBook onlyAccount(borrower) {
        if (amount == 0) revert InvalidAmount();
        if (!marketExists[newMarketKey]) revert UnknownMarket();
        if (!marketExists[repayMarketKey]) revert UnknownMarket();
        if (newMarketKey == repayMarketKey) revert SameMarketRollover();
        if (debts[borrower][repayMarketKey].faceValue == 0) revert NoRolloverDebt();

        _requireCurrentBorrowerRiskModule(borrower);
        _latchBorrowerRiskLevel(borrower, newMarketKey);
        _requireBorrowerRiskLevel(borrower, repayMarketKey);

        pendingBorrowPrincipal[borrower][newMarketKey] += amount;
        pendingRolloverBorrowPrincipal[borrower][newMarketKey] += amount;

        if (!borrowerPendingMarketSeen[borrower][newMarketKey]) {
            borrowerPendingMarketSeen[borrower][newMarketKey] = true;
            borrowerPendingMarkets[borrower].push(newMarketKey);
        }

        emit BorrowOrderRegistered(borrower, newMarketKey, amount);
    }

    function onRolloverBorrowOrderCancelled(
        address borrower,
        bytes32 newMarketKey,
        uint256 amount,
        bytes32
    ) external onlyOrderBook onlyAccount(borrower) {
        if (amount == 0) revert InvalidAmount();

        uint256 pending = pendingBorrowPrincipal[borrower][newMarketKey];
        if (pending < amount) revert CancelExceedsPending();
        uint256 pendingRollover = pendingRolloverBorrowPrincipal[borrower][newMarketKey];
        if (pendingRollover < amount) revert CancelExceedsRollover();

        unchecked {
            pendingBorrowPrincipal[borrower][newMarketKey] = pending - amount;
            pendingRolloverBorrowPrincipal[borrower][newMarketKey] = pendingRollover - amount;
        }

        if (pendingBorrowPrincipal[borrower][newMarketKey] == 0) {
            _removePendingMarketIfZero(borrower, newMarketKey);
        }
        _clearBorrowerRiskLevelIfFlat(borrower);

        emit BorrowOrderReleased(borrower, newMarketKey, amount);
    }

    function onRolloverBorrowOrderMatched(
        address borrower,
        bytes32 newMarketKey,
        uint256 amount
    ) external onlyOrderBook onlyAccount(borrower) {
        if (amount == 0) revert InvalidAmount();
        uint256 pendingRollover = pendingRolloverBorrowPrincipal[borrower][newMarketKey];
        if (pendingRollover < amount) revert MatchedExceedsRollover();

        unchecked {
            pendingRolloverBorrowPrincipal[borrower][newMarketKey] = pendingRollover - amount;
        }

        if (pendingBorrowPrincipal[borrower][newMarketKey] == 0) {
            _removePendingMarketIfZero(borrower, newMarketKey);
        }
    }

    function executeMatch(
        address lender,
        address borrower,
        bytes32 marketKey,
        uint256 principal,
        uint256 rateBps
    )
        external
        onlyOrderBook
        onlyAccount(lender)
        onlyAccount(borrower)
        returns (uint256 bondIndex, uint256 faceValue)
    {
        if (!marketExists[marketKey]) revert UnknownMarket();
        MarketConfig memory m = markets[marketKey];
        if (!m.active) revert MarketInactive();
        if (m.expiry <= block.timestamp) revert MarketExpired();
        if (principal == 0) revert InvalidAmount();
        if (marketSettlements[marketKey].primarySettled) revert MarketAlreadySettled();

        _requireCurrentBorrowerRiskModule(borrower);
        _requireBorrowerRiskLevel(borrower, marketKey);

        faceValue = _computeFaceValue(principal, rateBps, m.expiry);

        uint256 pending = pendingBorrowPrincipal[borrower][marketKey];
        if (pending < principal) revert MatchedExceedsPending();
        unchecked {
            pendingBorrowPrincipal[borrower][marketKey] = pending - principal;
        }
        if (pendingBorrowPrincipal[borrower][marketKey] == 0) {
            _removePendingMarketIfZero(borrower, marketKey);
        }

        debts[borrower][marketKey].principal += principal;
        debts[borrower][marketKey].faceValue += faceValue;

        if (!borrowerActiveMarketSeen[borrower][marketKey]) {
            borrowerActiveMarketSeen[borrower][marketKey] = true;
            borrowerActiveMarkets[borrower].push(marketKey);
        }

        bondIndex = nextBondIndex++;
        bondLots[bondIndex] = BondLot({
            owner: lender,
            marketKey: marketKey,
            faceValue: faceValue,
            initialRedeemed: false,
            supplementalClaimedPerFaceRay: 0
        });
        userBondLots[lender].push(bondIndex);

        MarketTotals storage totals = marketTotals[marketKey];
        totals.totalPrincipal += principal;
        totals.totalFaceValue += faceValue;
        totals.outstandingPrincipal += principal;
        totals.outstandingFaceValue += faceValue;

        emit LoanMatched(lender, borrower, marketKey, principal, faceValue, rateBps, bondIndex);
    }

    function settleMarket(bytes32 marketKey) external onlyRole(GOVERNOR_ROLE) {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (block.timestamp < markets[marketKey].expiry) revert MarketNotMatured();

        MarketSettlement storage ms = marketSettlements[marketKey];
        if (ms.primarySettled) revert MarketAlreadySettled();

        MarketTotals memory totals = marketTotals[marketKey];
        uint256 totalFace = totals.totalFaceValue;
        uint256 recovered = recoveredBeforeSettlement[marketKey];

        uint256 cappedRecovered = recovered > totalFace ? totalFace : recovered;
        uint256 initialRecoveryRateRay =
            totalFace == 0 ? RAY : _mulDivDown(cappedRecovered, RAY, totalFace);

        ms.primarySettled = true;
        ms.settlementTimestamp = uint64(block.timestamp);
        ms.initialRecoveryRateRay = initialRecoveryRateRay;
        ms.supplementalRecoveryPerFaceRay = 0;
        ms.totalRecoveredAtSettlement = cappedRecovered;
        ms.settledTotalFaceValue = totalFace;

        emit MarketPrimarySettled(marketKey, initialRecoveryRateRay, cappedRecovered);
    }

    function redeemInitial(uint256 bondIndex) external returns (uint256 amount) {
        BondLot storage lot = bondLots[bondIndex];
        if (lot.owner != msg.sender) revert NotOwner();

        MarketSettlement memory ms = marketSettlements[lot.marketKey];
        if (!ms.primarySettled) revert MarketNotSettled();
        if (lot.initialRedeemed) revert AlreadyRedeemed();

        amount = _mulDivDown(lot.faceValue, ms.initialRecoveryRateRay, RAY);
        if (getMarketClaimableLiquidity(lot.marketKey) < amount) {
            revert InsufficientMarketLiquidity();
        }

        lot.initialRedeemed = true;
        marketClaimedEth[lot.marketKey] += amount;

        emit BondInitialRedeemed(bondIndex, msg.sender, lot.marketKey, amount);
        emit MarketEscrowClaimed(lot.marketKey, amount, marketClaimedEth[lot.marketKey]);

        vault.payFromSettlement(lot.marketKey, msg.sender, amount, "lending_initial_redeem");
    }

    function claimSupplemental(uint256 bondIndex) external returns (uint256 amount) {
        BondLot storage lot = bondLots[bondIndex];
        if (lot.owner != msg.sender) revert NotOwner();

        MarketSettlement storage ms = marketSettlements[lot.marketKey];
        if (!ms.primarySettled) revert MarketNotSettled();

        uint256 currentPerFace = ms.supplementalRecoveryPerFaceRay;
        if (currentPerFace <= lot.supplementalClaimedPerFaceRay) revert NothingClaimable();

        uint256 deltaPerFace = currentPerFace - lot.supplementalClaimedPerFaceRay;
        amount = _mulDivDown(lot.faceValue, deltaPerFace, RAY);
        if (getMarketClaimableLiquidity(lot.marketKey) < amount) {
            revert InsufficientMarketLiquidity();
        }

        lot.supplementalClaimedPerFaceRay = currentPerFace;
        marketClaimedEth[lot.marketKey] += amount;

        emit BondSupplementalClaimed(bondIndex, msg.sender, lot.marketKey, amount);
        emit MarketEscrowClaimed(lot.marketKey, amount, marketClaimedEth[lot.marketKey]);

        vault.payFromSettlement(lot.marketKey, msg.sender, amount, "lending_supplemental_claim");
    }

    function transferBond(uint256 bondIndex, address to) external {
        if (to == address(0)) revert BadRecipient();

        BondLot storage lot = bondLots[bondIndex];
        if (lot.owner != msg.sender) revert NotOwner();

        _removeUserBondLot(msg.sender, bondIndex);
        userBondLots[to].push(bondIndex);
        lot.owner = to;

        emit BondTransferred(bondIndex, msg.sender, to);
    }

    function repayDebtFromAccountVault(
        bytes32 marketKey,
        uint256 amount
    ) external onlyAccount(msg.sender) returns (uint256 applied) {
        applied = _collectAndApplyDebtRepayment(msg.sender, marketKey, amount, "lending_repayment");
    }

    function repayDebtFromAccountVaultFor(
        address borrower,
        bytes32 marketKey,
        uint256 amount
    ) external onlyOrderBook onlyAccount(borrower) returns (uint256 applied) {
        applied = _collectAndApplyDebtRepayment(
            borrower,
            marketKey,
            amount,
            "lending_rollover_repayment"
        );
    }

    function _collectAndApplyDebtRepayment(
        address borrower,
        bytes32 marketKey,
        uint256 amount,
        string memory reason
    ) internal returns (uint256 applied) {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (amount == 0) revert InvalidAmount();

        uint256 debtFace = debts[borrower][marketKey].faceValue;
        if (debtFace == 0) revert NoDebt();

        uint256 appliedPreview = amount > debtFace ? debtFace : amount;
        vault.collectFreeEthToSettlement(marketKey, borrower, appliedPreview, reason);

        applied = _applyDebtRepayment(borrower, marketKey, amount);
        if (applied != appliedPreview) revert AppliedMismatch();
    }

    function repayDebtFromVaultRecovery(
        address borrower,
        bytes32 marketKey,
        uint256 amount
    ) external onlyRole(LOSS_MANAGER_ROLE) onlyAccount(borrower) returns (uint256 applied) {
        applied = _applyDebtRepayment(borrower, marketKey, amount);
    }

    function recordBorrowerMarketLoss(
        address borrower,
        bytes32 marketKey,
        uint256 lossAmount
    ) external onlyRole(LOSS_MANAGER_ROLE) onlyAccount(borrower) {
        _recordBorrowerMarketLoss(borrower, marketKey, lossAmount);
    }

    function recordMarketLoss(bytes32, uint256) external pure {
        revert UseBorrowerLoss();
    }

    function _recordBorrowerMarketLoss(
        address borrower,
        bytes32 marketKey,
        uint256 lossAmount
    ) internal {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (lossAmount == 0) revert InvalidAmount();
        if (marketSettlements[marketKey].primarySettled) revert MarketAlreadySettled();

        DebtPosition storage debt = debts[borrower][marketKey];
        if (debt.faceValue == 0) revert NoDebt();
        if (lossAmount > debt.faceValue) revert LossExceedsBorrowerDebt();

        uint256 oldFaceValue = debt.faceValue;
        uint256 oldPrincipal = debt.principal;
        uint256 principalLoss =
            lossAmount == oldFaceValue
                ? oldPrincipal
                : _mulDivDown(oldPrincipal, lossAmount, oldFaceValue);

        debt.faceValue = oldFaceValue - lossAmount;
        debt.principal = oldPrincipal > principalLoss ? oldPrincipal - principalLoss : 0;

        MarketTotals storage totals = marketTotals[marketKey];
        totals.outstandingFaceValue =
            totals.outstandingFaceValue > lossAmount ? totals.outstandingFaceValue - lossAmount : 0;
        totals.outstandingPrincipal =
            totals.outstandingPrincipal > principalLoss
                ? totals.outstandingPrincipal - principalLoss
                : 0;
        totals.cumulativeLosses += lossAmount;

        if (
            recoveredBeforeSettlement[marketKey] + totals.cumulativeLosses > totals.totalFaceValue
        ) {
            revert ResolvedExceedsFace();
        }

        if (debt.faceValue == 0) {
            debt.principal = 0;
            _removeActiveMarketIfZero(borrower, marketKey);
        }
        _clearBorrowerRiskLevelIfFlat(borrower);

        emit MarketLossRecorded(
            borrower,
            marketKey,
            lossAmount,
            totals.cumulativeLosses,
            debt.principal,
            debt.faceValue,
            totals.outstandingFaceValue
        );
    }

    function recordRecoveryFromVault(
        bytes32 marketKey,
        uint256 amount
    ) external onlyRole(RECOVERY_MANAGER_ROLE) {
        _recordRecoveryAccounting(marketKey, amount);
    }

    function _recordRecoveryAccounting(bytes32 marketKey, uint256 amount) internal {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (amount == 0) revert InvalidAmount();

        MarketSettlement storage ms = marketSettlements[marketKey];
        MarketTotals storage totals = marketTotals[marketKey];

        marketEscrowedEth[marketKey] += amount;
        emit MarketEscrowFunded(marketKey, amount, marketEscrowedEth[marketKey]);

        if (!ms.primarySettled) {
            uint256 resolvedBefore = recoveredBeforeSettlement[marketKey] + totals.cumulativeLosses;
            if (resolvedBefore + amount > totals.totalFaceValue) revert ResolvedExceedsFace();

            uint256 appliedToOutstanding =
                amount > totals.outstandingFaceValue ? totals.outstandingFaceValue : amount;

            totals.outstandingFaceValue -= appliedToOutstanding;

            if (totals.outstandingPrincipal > totals.outstandingFaceValue) {
                totals.outstandingPrincipal = totals.outstandingFaceValue;
            }

            recoveredBeforeSettlement[marketKey] += amount;

            emit RecoveryRecordedBeforeSettlement(
                marketKey,
                amount,
                recoveredBeforeSettlement[marketKey],
                totals.cumulativeLosses
            );
            return;
        }

        if (ms.settledTotalFaceValue == 0) return;

        uint256 currentTotalRecoveryRay =
            ms.initialRecoveryRateRay + ms.supplementalRecoveryPerFaceRay;

        if (currentTotalRecoveryRay >= RAY) return;

        uint256 deltaPerFaceRay = _mulDivDown(amount, RAY, ms.settledTotalFaceValue);
        uint256 remainingRay = RAY - currentTotalRecoveryRay;

        if (deltaPerFaceRay > remainingRay) {
            deltaPerFaceRay = remainingRay;
        }

        ms.supplementalRecoveryPerFaceRay += deltaPerFaceRay;

        emit SupplementalRecoveryRecorded(marketKey, amount, ms.supplementalRecoveryPerFaceRay);
    }

    function _applyDebtRepayment(
        address borrower,
        bytes32 marketKey,
        uint256 amount
    ) internal returns (uint256 applied) {
        if (!marketExists[marketKey]) revert UnknownMarket();
        if (amount == 0) revert InvalidAmount();

        DebtPosition storage debt = debts[borrower][marketKey];
        if (debt.faceValue == 0) revert NoDebt();

        uint256 oldFaceValue = debt.faceValue;
        uint256 oldPrincipal = debt.principal;

        applied = amount > oldFaceValue ? oldFaceValue : amount;

        uint256 principalReduction =
            applied == oldFaceValue
                ? oldPrincipal
                : _mulDivDown(oldPrincipal, applied, oldFaceValue);

        debt.faceValue = oldFaceValue - applied;
        debt.principal = oldPrincipal - principalReduction;

        MarketTotals storage totals = marketTotals[marketKey];
        // Repayments reduce borrower debt outstanding, but must not shrink the
        // original market face value used as the bondholder claim denominator.
        totals.outstandingFaceValue =
            totals.outstandingFaceValue > applied ? totals.outstandingFaceValue - applied : 0;
        totals.outstandingPrincipal =
            totals.outstandingPrincipal > principalReduction
                ? totals.outstandingPrincipal - principalReduction
                : 0;

        marketEscrowedEth[marketKey] += applied;
        emit MarketEscrowFunded(marketKey, applied, marketEscrowedEth[marketKey]);

        MarketSettlement storage ms = marketSettlements[marketKey];
        if (!ms.primarySettled) {
            recoveredBeforeSettlement[marketKey] += applied;
            if (
                recoveredBeforeSettlement[marketKey] + totals.cumulativeLosses >
                totals.totalFaceValue
            ) {
                revert ResolvedExceedsFace();
            }
        } else if (applied > 0 && ms.settledTotalFaceValue > 0) {
            uint256 currentTotalRecoveryRay =
                ms.initialRecoveryRateRay + ms.supplementalRecoveryPerFaceRay;

            if (currentTotalRecoveryRay < RAY) {
                uint256 addRay = _mulDivDown(applied, RAY, ms.settledTotalFaceValue);

                uint256 remainingRay = RAY - currentTotalRecoveryRay;
                if (addRay > remainingRay) {
                    addRay = remainingRay;
                }

                ms.supplementalRecoveryPerFaceRay += addRay;
            }
        }

        if (debt.faceValue == 0) {
            debt.principal = 0;
            _removeActiveMarketIfZero(borrower, marketKey);
        }
        _clearBorrowerRiskLevelIfFlat(borrower);

        emit DebtRepaid(
            borrower,
            marketKey,
            amount,
            applied,
            principalReduction,
            debt.principal,
            debt.faceValue
        );
    }

    function _requireCurrentBorrowerRiskModule(address borrower) internal view {
        if (!accountRegistry.isLendingAccount(borrower)) revert BorrowerMustBeLendingAccount();
        if (address(riskModule) == address(0)) revert RiskModuleNotSet();
        if (ILendingAccountRiskModuleView(borrower).riskModule() != address(riskModule)) {
            revert OutdatedRiskModule();
        }
    }

    function _latchBorrowerRiskLevel(address borrower, bytes32 marketKey) internal {
        if (address(riskModule) == address(0)) revert RiskModuleNotSet();
        riskModule.latchAccountRiskLevel(borrower, markets[marketKey].riskLevel);
    }

    function _requireBorrowerRiskLevel(address borrower, bytes32 marketKey) internal view {
        if (address(riskModule) == address(0)) revert RiskModuleNotSet();
        riskModule.requireAccountRiskLevel(borrower, markets[marketKey].riskLevel);
    }

    function _clearBorrowerRiskLevelIfFlat(address borrower) internal {
        if (address(riskModule) == address(0)) return;
        if (getAccountTotalDebt(borrower) != 0) return;
        if (getAccountPendingBorrow(borrower) != 0) return;
        riskModule.clearAccountRiskLevel(borrower);
    }

    function _computeFaceValue(
        uint256 principal,
        uint256 rateBps,
        uint64 expiry
    ) internal view returns (uint256 faceValue) {
        if (expiry <= block.timestamp) revert ExpiryPassed();
        uint256 timeToExpiry = uint256(expiry) - block.timestamp;
        uint256 interest = (principal * rateBps * timeToExpiry) / YEAR / BPS;
        faceValue = principal + interest;
    }

    function _removePendingMarketIfZero(address borrower, bytes32 marketKey) internal {
        if (pendingBorrowPrincipal[borrower][marketKey] != 0) return;
        if (pendingRolloverBorrowPrincipal[borrower][marketKey] != 0) return;
        if (!borrowerPendingMarketSeen[borrower][marketKey]) return;

        bytes32[] storage arr = borrowerPendingMarkets[borrower];
        uint256 len = arr.length;

        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == marketKey) {
                if (i != len - 1) arr[i] = arr[len - 1];
                arr.pop();
                borrowerPendingMarketSeen[borrower][marketKey] = false;
                return;
            }
        }

        borrowerPendingMarketSeen[borrower][marketKey] = false;
    }

    function _removeActiveMarketIfZero(address borrower, bytes32 marketKey) internal {
        if (debts[borrower][marketKey].faceValue != 0) return;
        if (!borrowerActiveMarketSeen[borrower][marketKey]) return;

        bytes32[] storage arr = borrowerActiveMarkets[borrower];
        uint256 len = arr.length;

        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == marketKey) {
                if (i != len - 1) arr[i] = arr[len - 1];
                arr.pop();
                borrowerActiveMarketSeen[borrower][marketKey] = false;
                return;
            }
        }

        borrowerActiveMarketSeen[borrower][marketKey] = false;
    }

    function _isAllowedExpiry(uint64 expiry) internal pure returns (bool) {
        DateParts memory d = _timestampToDateParts(expiry);
        if (d.weekday != 5) return false; // Friday
        if (d.hour != 12 || d.minute != 0 || d.second != 0) return false;

        DateParts memory nextWeek = _timestampToDateParts(expiry + 7 days);
        return nextWeek.month != d.month; // last Friday of month
    }

    function _timestampToDateParts(uint256 timestamp) internal pure returns (DateParts memory dp) {
        (uint256 year, uint256 month, uint256 day) = _daysToDate(timestamp / 86400);
        uint256 secs = timestamp % 86400;
        uint256 hour = secs / 3600;
        secs %= 3600;
        uint256 minute = secs / 60;
        uint256 second = secs % 60;
        uint256 weekday = (timestamp / 86400 + 4) % 7;
        dp = DateParts(year, month, day, hour, minute, second, weekday);
    }

    function _daysToDate(
        uint256 _days
    ) internal pure returns (uint256 year, uint256 month, uint256 day) {
        int256 __days = int256(_days);
        int256 L = __days + 68569 + 2440588;
        int256 N = (4 * L) / 146097;
        L = L - (146097 * N + 3) / 4;
        int256 _year = (4000 * (L + 1)) / 1461001;
        L = L - (1461 * _year) / 4 + 31;
        int256 _month = (80 * L) / 2447;
        int256 _day = L - (2447 * _month) / 80;
        L = _month / 11;
        _month = _month + 2 - 12 * L;
        _year = 100 * (N - 49) + _year + L;
        year = uint256(_year);
        month = uint256(_month);
        day = uint256(_day);
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 0;
        return (a * b) / d;
    }

    function _removeUserBondLot(address owner, uint256 bondIndex) internal {
        uint256[] storage arr = userBondLots[owner];
        uint256 len = arr.length;

        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == bondIndex) {
                if (i != len - 1) arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }

        revert BondNotInOwnerList();
    }
}
