// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { PriceManager } from "../../oracle/PriceManager.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { IPriceOracle } from "../../oracle/interfaces/IPriceOracle.sol";

import { FuturesPositionStore } from "./FuturesPositionStore.sol";
import { FuturesTypes } from "./FuturesTypes.sol";

contract FuturesContract is AccessControl {
    // -------- Errors --------
    error NotRegisteredAccount();
    error OrderBookOnly();

    error ZeroAddress();
    error PriceManagerNotSet();
    error InvalidOracle();
    error MarketAlreadyExists();
    error UnknownMarket();
    error MarketAlreadyClosed();
    error MarketAlreadyOpen();
    error MarketIsClosed();

    error InvalidInitialMargin();
    error InvalidMaintenanceMargin();
    error InvalidMultiplier();
    error InvalidPrice();
    error InvalidIndex();

    error InvalidUser();
    error InvalidSize();
    error InvalidReduction();
    error InvalidPosition();
    error PositionNotActive();
    error PositionInactive();

    error InsufficientMargin();
    error InvalidAmount();
    error NotLiquidatable();
    error NoMargin();
    error NoExcessMargin();

    error InvalidPositionSide();
    error PositionAlreadyIndexed();
    error PositionNotIndexed();
    error InvalidLiquidationIndex();
    error InvalidDivider();

    error SettlementPriceStale();
    error InvalidSettlementAge();

    error PositionStoreNotSet();

    // -------- Roles --------

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");

    // -------- External refs --------
    AccountRegistry public immutable accountRegistry;
    SethxVault public immutable vault;
    PriceManager public priceManager;
    FuturesPositionStore public positionStore;

    // -------- Storage --------

    uint256 public maxRebaseSteps = 10;
    uint256 public maxTreasuryRebaseSteps = 50;
    uint256 public maxLiquidationSteps = 50;
    uint256 public liquidationRewardBps = 500; // 5%
    uint256 public liquidationTickDivider = 50;
    uint256 public maxImbalanceSettlementAge = 1 hours;

    mapping(bytes32 => FuturesTypes.MarketConfig) public markets;

    // -------- Market index (for frontends) --------
    bytes32[] private _marketKeys;

    /// @notice whether a market is currently open for new exposure (order placement/matching to open/increase).
    /// Close/reduce orders should still be possible when closed (enforced in OrderBook; ledger allows reduce always).
    mapping(bytes32 => bool) public marketActive;

    /// positions[marketKey][account]
    mapping(bytes32 => mapping(address => FuturesTypes.Position)) public positions;

    /// Open interest totals (size units)
    mapping(bytes32 => uint256) public totalLongs;
    mapping(bytes32 => uint256) public totalShorts;

    /// @notice Accounting-only label for the part of vault settlementEthLocked sourced from liquidations.
    /// @dev The ETH itself remains in SethxVault.settlementEthLocked; this value is consumed only
    /// when imbalanced winning-side PnL receives liquidation-buffer compensation.
    mapping(bytes32 => uint256) public liquidationSettlementBuffer;

    // -------- Events --------
    event MarketCreated(bytes32 indexed marketKey, address indexed oracle, string ticker);
    event MarketOpened(bytes32 indexed marketKey);
    event MarketClosed(bytes32 indexed marketKey);

    event MarketRiskParamsUpdated(
        bytes32 indexed marketKey,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 multiplier
    );
    event MarketPriceUpdated(bytes32 indexed marketKey, uint256 rawPrice, uint256 blockNumber);

    event PositionOpened(
        address indexed user,
        bytes32 indexed marketKey,
        uint256 sizeDelta,
        uint256 marginDelta,
        bool isLong
    );
    event PositionReduced(
        address indexed user,
        bytes32 indexed marketKey,
        uint256 reduction,
        bool isLong
    );
    event MarginAdjusted(
        address indexed user,
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed side,
        int256 delta,
        uint256 newMargin
    );

    event PositionSettled(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        int256 pnlApplied,
        uint256 newMargin
    );

    event PositionClosed(address indexed user, bytes32 indexed marketKey, uint256 releasedMargin);

    event Liquidated(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        uint256 size,
        uint256 rawPrice,
        uint256 seizedMargin
    );

    event HeadLiquidationProcessed(
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed side,
        uint256 processed,
        uint256 stoppedAtPrice
    );

    event TradeProcessed(
        address indexed user,
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed tradeSide,
        uint256 sizeDelta,
        uint256 marginDelta,
        uint256 executionPriceRaw,
        uint256 referencePriceRaw
    );

    event LiquidationIndexUpdated(
        bytes32 indexed marketKey,
        address indexed account,
        FuturesTypes.PositionSide indexed side,
        uint256 oldLiquidationPrice,
        uint256 newLiquidationPrice,
        uint256 oldTick,
        uint256 newTick
    );

    event ReferencePriceIndexUpdated(
        bytes32 indexed marketKey,
        address indexed account,
        FuturesTypes.PositionSide indexed side,
        uint256 oldReferencePrice,
        uint256 newReferencePrice,
        uint256 oldTick,
        uint256 newTick
    );

    event LosingPositionsRebased(
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed side,
        address indexed caller,
        uint256 scanned,
        uint256 rebased,
        uint256 amountCollected,
        uint256 settlementBufferAfter
    );

    event LiquidationSettlementBufferIncreased(
        bytes32 indexed marketKey,
        uint256 amount,
        uint256 newBuffer
    );

    event LiquidationSettlementBufferUsed(
        bytes32 indexed marketKey,
        uint256 amount,
        uint256 newBuffer
    );

    event PositivePnlCorrectedForImbalance(
        address indexed account,
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed side,
        uint256 rawProfit,
        uint256 correctedProfit,
        uint256 paidProfit,
        uint256 liquidationBufferPortion,
        uint256 totalLongs,
        uint256 totalShorts
    );

    event SettlementPriceSynced(
        bytes32 indexed marketKey,
        address indexed oracle,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 blockNumber,
        uint256 timestamp
    );

    event MaxRebaseStepsUpdated(uint256 oldValue, uint256 newValue);
    event MaxTreasuryRebaseStepsUpdated(uint256 oldValue, uint256 newValue);
    event LiquidationRewardBpsUpdated(uint256 oldValue, uint256 newValue);
    event LiquidationTickDividerUpdated(uint256 oldDivider, uint256 newDivider);
    event MaxImbalanceSettlementAgeUpdated(uint256 oldAge, uint256 newAge);
    event MaxLiquidationStepsUpdated(uint256 oldValue, uint256 newValue);

    // -------- Modifiers --------
    modifier onlyAccount() {
        if (!accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender))
            revert NotRegisteredAccount();
        _;
    }

    modifier onlyOrderBook() {
        if (!hasRole(ORDERBOOK_ROLE, msg.sender)) revert OrderBookOnly();
        _;
    }

    // -------- Constructor / admin --------
    constructor(address _vault, address _accountRegistry, address admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setPriceManager(address _priceManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_priceManager == address(0)) revert ZeroAddress();
        priceManager = PriceManager(_priceManager);
    }

    function setOrderBook(address orderBook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (orderBook == address(0)) revert ZeroAddress();
        _grantRole(ORDERBOOK_ROLE, orderBook);
    }

    function setPositionStore(address store) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (store == address(0)) revert ZeroAddress();
        positionStore = FuturesPositionStore(store);
    }

    function _positionStore() internal view returns (FuturesPositionStore store) {
        store = positionStore;
        if (address(store) == address(0)) revert PositionStoreNotSet();
    }

    function setMaxRebaseSteps(uint256 newValue) external onlyRole(GOVERNOR_ROLE) {
        if (newValue == 0 || newValue > 100) revert InvalidAmount();

        uint256 oldValue = maxRebaseSteps;
        maxRebaseSteps = newValue;

        emit MaxRebaseStepsUpdated(oldValue, newValue);
    }

    function setMaxTreasuryRebaseSteps(uint256 newValue) external onlyRole(GOVERNOR_ROLE) {
        if (newValue == 0 || newValue > 500) revert InvalidAmount();

        uint256 oldValue = maxTreasuryRebaseSteps;
        maxTreasuryRebaseSteps = newValue;

        emit MaxTreasuryRebaseStepsUpdated(oldValue, newValue);
    }

    function setLiquidationRewardBps(uint256 newValue) external onlyRole(GOVERNOR_ROLE) {
        if (newValue > 2_000) revert InvalidAmount(); // max 20%

        uint256 oldValue = liquidationRewardBps;
        liquidationRewardBps = newValue;

        emit LiquidationRewardBpsUpdated(oldValue, newValue);
    }

    function setLiquidationTickDivider(uint256 newDivider) external onlyRole(GOVERNOR_ROLE) {
        if (newDivider < 5 || newDivider > 500) revert InvalidDivider();

        uint256 oldDivider = liquidationTickDivider;
        liquidationTickDivider = newDivider;

        emit LiquidationTickDividerUpdated(oldDivider, newDivider);
    }

    function setMaxImbalanceSettlementAge(uint256 newAge) external onlyRole(GOVERNOR_ROLE) {
        if (newAge == 0 || newAge > 7 days) revert InvalidSettlementAge();

        uint256 oldAge = maxImbalanceSettlementAge;
        maxImbalanceSettlementAge = newAge;

        emit MaxImbalanceSettlementAgeUpdated(oldAge, newAge);
    }

    function setMaxLiquidationSteps(uint256 newValue) external onlyRole(GOVERNOR_ROLE) {
        if (newValue == 0 || newValue > 500) revert InvalidAmount();

        uint256 oldValue = maxLiquidationSteps;
        maxLiquidationSteps = newValue;

        emit MaxLiquidationStepsUpdated(oldValue, newValue);
    }

    // -------- Market creation / lifecycle --------

    /// @notice Create an ETH-margined futures market for an oracle.
    /// @dev The oracle is the market identity and price source.
    /// Futures margin, settlement accounting, and PnL are always ETH-denominated.
    /// initialPriceRaw MUST be raw oracle price using the oracle's decimals.
    function createMarket(
        string calldata ticker,
        address oracle,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 multiplier,
        uint256 initialPriceRaw
    ) external onlyRole(GOVERNOR_ROLE) returns (bytes32 marketKey) {
        if (address(priceManager) == address(0)) revert PriceManagerNotSet();
        if (oracle == address(0)) revert ZeroAddress();

        if (!priceManager.isOracleUsableForFutures(oracle)) {
            revert InvalidOracle();
        }

        marketKey = computeMarketKey(oracle);

        if (markets[marketKey].oracle != address(0)) {
            revert MarketAlreadyExists();
        }

        if (initialMarginBps == 0 || initialMarginBps > 10_000) {
            revert InvalidInitialMargin();
        }

        if (maintenanceMarginBps == 0 || maintenanceMarginBps > initialMarginBps) {
            revert InvalidMaintenanceMargin();
        }

        if (multiplier == 0) revert InvalidMultiplier();
        if (initialPriceRaw == 0) revert InvalidPrice();

        uint8 oracleDecimals = IPriceOracle(oracle).decimals();
        uint8 marginDecimals = 18;

        markets[marketKey] = FuturesTypes.MarketConfig({
            ticker: ticker,
            oracle: oracle,
            oraclePriceDecimals: oracleDecimals,
            marginDecimals: marginDecimals,
            initialMarginBps: initialMarginBps,
            maintenanceMarginBps: maintenanceMarginBps,
            multiplier: multiplier,
            lastSettlementPrice: initialPriceRaw,
            lastSettlementBlock: block.number,
            lastSettlementTimestamp: block.timestamp
        });

        marketActive[marketKey] = true;

        // Index this market key for discovery (frontends/tests)
        _marketKeys.push(marketKey);

        emit MarketCreated(marketKey, oracle, ticker);
        emit MarketOpened(marketKey);
        emit MarketPriceUpdated(marketKey, initialPriceRaw, block.number);
    }

    // -------- Market discovery helpers --------
    function marketCount() external view returns (uint256) {
        return _marketKeys.length;
    }

    function marketKeyAt(uint256 index) external view returns (bytes32) {
        if (index >= _marketKeys.length) revert InvalidIndex();
        return _marketKeys[index];
    }

    function getMarketKeys() external view returns (bytes32[] memory) {
        return _marketKeys;
    }

    /// @notice Computes the futures market key.
    /// @dev address(0) represents ETH as the fixed margin/accounting token.
    function computeMarketKey(address oracle) public pure returns (bytes32) {
        return keccak256(abi.encode("SETHX_FUTURES", oracle, address(0)));
    }

    function closeMarket(bytes32 marketKey) external onlyRole(GOVERNOR_ROLE) {
        if (markets[marketKey].oracle == address(0)) revert UnknownMarket();
        if (!marketActive[marketKey]) revert MarketAlreadyClosed();
        marketActive[marketKey] = false;
        emit MarketClosed(marketKey);
    }

    function reopenMarket(bytes32 marketKey) external onlyRole(GOVERNOR_ROLE) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (marketActive[marketKey]) revert MarketAlreadyOpen();
        if (!priceManager.isOracleUsableForFutures(m.oracle)) revert InvalidOracle();
        marketActive[marketKey] = true;
        emit MarketOpened(marketKey);
    }

    function setMarketRiskParams(
        bytes32 marketKey,
        uint256 newInitialMarginBps,
        uint256 newMaintenanceMarginBps,
        uint256 newMultiplier
    ) external onlyRole(GOVERNOR_ROLE) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        if (newInitialMarginBps == 0 || newInitialMarginBps > 10_000) {
            revert InvalidInitialMargin();
        }

        if (newMaintenanceMarginBps == 0 || newMaintenanceMarginBps > newInitialMarginBps) {
            revert InvalidMaintenanceMargin();
        }

        if (newMultiplier == 0) revert InvalidMultiplier();

        m.initialMarginBps = newInitialMarginBps;
        m.maintenanceMarginBps = newMaintenanceMarginBps;
        m.multiplier = newMultiplier;

        emit MarketRiskParamsUpdated(
            marketKey,
            newInitialMarginBps,
            newMaintenanceMarginBps,
            newMultiplier
        );
    }

    function processTrade(
        address user,
        bytes32 marketKey,
        FuturesTypes.PositionSide tradeSide,
        uint256 sizeDelta,
        uint256 marginDelta,
        uint256 executionPriceRaw
    ) external onlyOrderBook {
        if (user == address(0)) revert InvalidUser();
        if (sizeDelta == 0) revert InvalidSize();

        _requireLiquidationSide(tradeSide);

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 mutationPrice = m.lastSettlementPrice;
        if (mutationPrice == 0) revert InvalidPrice();

        FuturesTypes.Position storage p = positions[marketKey][user];

        if (_isOpen(p)) {
            _rebasePositionToSettlement(marketKey, user, maxRebaseSteps);
        }

        if (!_isOpen(p)) {
            if (!marketActive[marketKey]) revert MarketIsClosed();

            _openNewPosition(marketKey, user, tradeSide, sizeDelta, marginDelta, mutationPrice);

            emit PositionOpened(
                user,
                marketKey,
                sizeDelta,
                marginDelta,
                tradeSide == FuturesTypes.PositionSide.Long
            );

            emit TradeProcessed(
                user,
                marketKey,
                tradeSide,
                sizeDelta,
                marginDelta,
                executionPriceRaw,
                mutationPrice
            );

            return;
        }

        if (p.side == tradeSide) {
            if (!marketActive[marketKey]) revert MarketIsClosed();

            _increasePosition(marketKey, user, sizeDelta, marginDelta, mutationPrice);

            emit TradeProcessed(
                user,
                marketKey,
                tradeSide,
                sizeDelta,
                marginDelta,
                executionPriceRaw,
                mutationPrice
            );

            return;
        }

        _reduceOrFlipPosition(marketKey, user, tradeSide, sizeDelta, marginDelta, mutationPrice);

        emit TradeProcessed(
            user,
            marketKey,
            tradeSide,
            sizeDelta,
            marginDelta,
            executionPriceRaw,
            mutationPrice
        );
    }

    function _openNewPosition(
        bytes32 marketKey,
        address user,
        FuturesTypes.PositionSide side,
        uint256 sizeDelta,
        uint256 marginDelta,
        uint256 mutationPrice
    ) internal {
        if (marginDelta == 0) revert InsufficientMargin();
        if (mutationPrice == 0) revert InvalidPrice();

        FuturesTypes.Position storage p = positions[marketKey][user];

        p.side = side;
        p.size = sizeDelta;
        p.margin = marginDelta;
        p.referencePrice = mutationPrice;
        p.lossIndexSnapshot = 0;

        if (side == FuturesTypes.PositionSide.Long) {
            totalLongs[marketKey] += sizeDelta;
        } else {
            totalShorts[marketKey] += sizeDelta;
        }

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            side,
            sizeDelta,
            marginDelta,
            mutationPrice
        );

        _reindexLiquidationPosition(marketKey, user, side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, user, side, mutationPrice);
    }

    function _increasePosition(
        bytes32 marketKey,
        address user,
        uint256 sizeDelta,
        uint256 marginDelta,
        uint256 mutationPrice
    ) internal {
        if (mutationPrice == 0) revert InvalidPrice();

        FuturesTypes.Position storage p = positions[marketKey][user];

        uint256 oldSize = p.size;
        uint256 newSize = oldSize + sizeDelta;

        p.referencePrice = ((oldSize * p.referencePrice) + (sizeDelta * mutationPrice)) / newSize;

        p.size = newSize;
        p.margin += marginDelta;

        if (p.side == FuturesTypes.PositionSide.Long) {
            totalLongs[marketKey] += sizeDelta;
        } else {
            totalShorts[marketKey] += sizeDelta;
        }

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, user, p.side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, user, p.side, p.referencePrice);
    }

    function _reduceOrFlipPosition(
        bytes32 marketKey,
        address user,
        FuturesTypes.PositionSide tradeSide,
        uint256 sizeDelta,
        uint256 marginDelta,
        uint256 mutationPrice
    ) internal {
        FuturesTypes.Position storage p = positions[marketKey][user];

        FuturesTypes.PositionSide oldSide = p.side;
        uint256 oldSize = p.size;

        uint256 reduceSize = sizeDelta < oldSize ? sizeDelta : oldSize;
        uint256 flipSize = sizeDelta > oldSize ? sizeDelta - oldSize : 0;

        if (oldSide == FuturesTypes.PositionSide.Long) {
            totalLongs[marketKey] -= reduceSize;
        } else {
            totalShorts[marketKey] -= reduceSize;
        }

        emit PositionReduced(
            user,
            marketKey,
            reduceSize,
            oldSide == FuturesTypes.PositionSide.Long
        );

        // ---------------------------------------------------------
        // Case 1: partial reduce, position remains.
        // Keep all margin on the remaining position.
        // User can later call releaseExcessMargin if margin is above requirement.
        // ---------------------------------------------------------
        if (flipSize == 0 && reduceSize < oldSize) {
            p.size = oldSize - reduceSize;
            p.referencePrice = mutationPrice;

            uint256 liquidationPrice = _calculateLiquidationPrice(
                marketKey,
                p.side,
                p.size,
                p.margin,
                p.referencePrice
            );

            _reindexLiquidationPosition(marketKey, user, p.side, liquidationPrice);
            _reindexReferencePricePosition(marketKey, user, p.side, p.referencePrice);

            return;
        }

        // From here, old position is fully closed.
        uint256 remainingMargin = p.margin;

        _clearLiquidationPosition(marketKey, user);
        _clearReferencePricePosition(marketKey, user);

        // ---------------------------------------------------------
        // Case 2: full close, no flip.
        // Release all remaining margin automatically.
        // ---------------------------------------------------------
        if (flipSize == 0) {
            delete positions[marketKey][user];

            if (remainingMargin > 0) {
                vault.unlockETH(user, remainingMargin);
            }

            emit PositionClosed(user, marketKey, remainingMargin);

            return;
        }

        // ---------------------------------------------------------
        // Case 3: flip into opposite side.
        // Carry all remaining margin into the new position.
        // Add any new opening margin supplied by the orderbook.
        // ---------------------------------------------------------
        if (!marketActive[marketKey]) revert MarketIsClosed();

        uint256 newMargin = remainingMargin + marginDelta;

        p.side = tradeSide;
        p.size = flipSize;
        p.margin = newMargin;
        p.referencePrice = mutationPrice;
        p.lossIndexSnapshot = 0;

        if (tradeSide == FuturesTypes.PositionSide.Long) {
            totalLongs[marketKey] += flipSize;
        } else {
            totalShorts[marketKey] += flipSize;
        }

        uint256 newLiquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, user, p.side, newLiquidationPrice);
        _reindexReferencePricePosition(marketKey, user, p.side, p.referencePrice);

        emit PositionOpened(
            user,
            marketKey,
            flipSize,
            marginDelta,
            tradeSide == FuturesTypes.PositionSide.Long
        );
    }

    function _computePnLFromReference(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 size,
        uint256 referenceRaw,
        uint256 settlementRaw
    ) internal view returns (int256) {
        _requireLiquidationSide(side);

        if (size == 0) return 0;
        if (referenceRaw == 0 || settlementRaw == 0) revert InvalidPrice();

        FuturesTypes.MarketConfig storage m = markets[marketKey];

        uint256 referenceN = _normalizePrice(referenceRaw, m.oraclePriceDecimals, m.marginDecimals);

        uint256 settlementN = _normalizePrice(
            settlementRaw,
            m.oraclePriceDecimals,
            m.marginDecimals
        );

        if (referenceN == settlementN) return 0;

        bool priceUp = settlementN > referenceN;
        uint256 absDelta = priceUp ? settlementN - referenceN : referenceN - settlementN;

        uint256 denom = 10 ** uint256(m.marginDecimals);
        uint256 pnlAbs = (size * m.multiplier * absDelta) / denom;

        bool positive = side == FuturesTypes.PositionSide.Long ? priceUp : !priceUp;

        return positive ? int256(pnlAbs) : -int256(pnlAbs);
    }

    function syncSettlementPrice(bytes32 marketKey) external returns (uint256 newPriceRaw) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (address(priceManager) == address(0)) revert PriceManagerNotSet();

        uint256 oldPrice = m.lastSettlementPrice;

        (newPriceRaw, ) = _readStoredSettlementPrice(m);

        if (newPriceRaw == 0) {
            _tryRefreshSettlementOracle(m.oracle);
            (newPriceRaw, ) = _readStoredSettlementPrice(m);
        }

        if (newPriceRaw == 0) revert InvalidPrice();

        m.lastSettlementPrice = newPriceRaw;
        m.lastSettlementBlock = block.number;
        m.lastSettlementTimestamp = block.timestamp;

        emit MarketPriceUpdated(marketKey, newPriceRaw, block.number);
        emit SettlementPriceSynced(
            marketKey,
            m.oracle,
            oldPrice,
            newPriceRaw,
            block.number,
            block.timestamp
        );
    }

    function requireFreshImbalanceSettlement(bytes32 marketKey) external view {
        _requireFreshImbalanceSettlement(marketKey);
    }

    function _requireFreshImbalanceSettlement(bytes32 marketKey) internal view {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        if (
            m.lastSettlementTimestamp == 0 ||
            block.timestamp > m.lastSettlementTimestamp + maxImbalanceSettlementAge
        ) {
            revert SettlementPriceStale();
        }
    }

    function liquidatePosition(
        bytes32 marketKey,
        address account
    ) external onlyAccount returns (uint256 seizedMargin, uint256 callerReward) {
        if (account == address(0)) revert InvalidUser();

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        FuturesTypes.Position storage p = positions[marketKey][account];
        if (!_isOpen(p)) revert PositionNotActive();

        if (!_isLiquidatableAtSettlement(marketKey, p, settlementPrice)) {
            revert NotLiquidatable();
        }

        return _liquidatePosition(marketKey, account, settlementPrice, msg.sender);
    }

    function liquidateHead(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 maxSteps
    ) external onlyAccount returns (uint256 processed) {
        _requireLiquidationSide(side);

        uint256 effectiveMaxSteps = maxSteps;

        if (effectiveMaxSteps == 0) revert InvalidAmount();

        if (effectiveMaxSteps > maxLiquidationSteps) {
            effectiveMaxSteps = maxLiquidationSteps;
        }

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        while (processed < effectiveMaxSteps) {
            address account = _positionStore().getLiquidationHead(marketKey, side);
            if (account == address(0)) break;

            FuturesTypes.LiquidationNode memory node = _positionStore().getLiquidationNode(
                marketKey,
                account
            );

            if (!node.active || node.side != side) {
                _clearLiquidationPosition(marketKey, account);
                processed++;
                continue;
            }

            // Fast head-price check.
            // If the head itself is not inside the liquidation zone,
            // no later node on this side can be liquidatable either.
            if (!_headIsLiquidatable(side, node.liquidationPrice, settlementPrice)) {
                break;
            }

            FuturesTypes.Position storage p = positions[marketKey][account];

            if (!_isOpen(p) || p.side != side) {
                _clearLiquidationPosition(marketKey, account);
                processed++;
                continue;
            }

            bool liquidatable = _isLiquidatableAtSettlement(marketKey, p, settlementPrice);

            if (!liquidatable) {
                // Since this was the head and is not liquidatable,
                // stop. The rest of the ordered side should be safer.
                break;
            }

            _liquidatePosition(marketKey, account, settlementPrice, msg.sender);

            processed++;
        }

        emit HeadLiquidationProcessed(marketKey, side, processed, settlementPrice);
    }

    function _liquidatePosition(
        bytes32 marketKey,
        address account,
        uint256 settlementPrice,
        address caller
    ) internal returns (uint256 seizedMargin, uint256 callerReward) {
        FuturesTypes.Position storage p = positions[marketKey][account];

        if (!_isOpen(p)) revert PositionNotActive();

        FuturesTypes.PositionSide side = p.side;
        uint256 size = p.size;

        seizedMargin = p.margin;

        _clearLiquidationPosition(marketKey, account);
        _clearReferencePricePosition(marketKey, account);

        if (side == FuturesTypes.PositionSide.Long) {
            totalLongs[marketKey] -= size;
        } else {
            totalShorts[marketKey] -= size;
        }

        delete positions[marketKey][account];

        if (seizedMargin > 0) {
            callerReward = (seizedMargin * liquidationRewardBps) / 10_000;
            uint256 toSettlement = seizedMargin - callerReward;

            if (callerReward > 0) {
                vault.transferETH(account, caller, callerReward, "futures_liquidation_reward");
            }

            if (toSettlement > 0) {
                vault.collectToSettlement(
                    marketKey,
                    account,
                    address(0),
                    toSettlement,
                    "futures_liquidation_seized_margin"
                );

                liquidationSettlementBuffer[marketKey] += toSettlement;

                emit LiquidationSettlementBufferIncreased(
                    marketKey,
                    toSettlement,
                    liquidationSettlementBuffer[marketKey]
                );
            }
        }

        emit PositionReduced(account, marketKey, size, side == FuturesTypes.PositionSide.Long);

        emit Liquidated(
            account,
            marketKey,
            side == FuturesTypes.PositionSide.Long,
            size,
            settlementPrice,
            seizedMargin
        );
    }

    // -------- Views --------

    function getMarket(bytes32 marketKey) external view returns (FuturesTypes.MarketConfig memory) {
        return markets[marketKey];
    }

    function getPosition(
        address user,
        bytes32 marketKey
    ) external view returns (FuturesTypes.Position memory) {
        return positions[marketKey][user];
    }

    function getOpenInterestImbalance(bytes32 marketKey) external view returns (int256) {
        return int256(totalLongs[marketKey]) - int256(totalShorts[marketKey]);
    }

    /// @notice Normalize a raw oracle price into ETH margin decimals scale.
    function normalizePrice(bytes32 marketKey, uint256 rawPrice) public view returns (uint256) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        return _normalizePrice(rawPrice, m.oraclePriceDecimals, m.marginDecimals);
    }

    /// @notice Maintenance requirement at mark for a given size (ETH units).
    function maintenanceRequiredAtMark(
        bytes32 marketKey,
        uint256 size,
        uint256 markRawPrice
    ) public view returns (uint256) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 priceNorm = _normalizePrice(markRawPrice, m.oraclePriceDecimals, m.marginDecimals);
        uint256 denom = 10_000 * (10 ** uint256(m.marginDecimals));

        return (size * m.multiplier * priceNorm * m.maintenanceMarginBps) / denom;
    }

    function tickForLiquidationPrice(uint256 liquidationPrice) public view returns (uint256) {
        // A zero liquidation price is valid for overcollateralized longs:
        // they are not liquidatable at any positive settlement price. Use tick 0
        // as the explicit sentinel for that non-liquidatable long bucket.
        if (liquidationPrice == 0) return 0;

        uint256 mag = _pow10(_floorLog10(liquidationPrice));
        uint256 tick = mag / liquidationTickDivider;
        if (tick == 0) tick = 1;

        return tick;
    }

    // -------- Internal: margin-per-unit + bounds --------

    /// @dev A = margin * 10^marginDecimals  / (size * multiplier)
    function _computeMarginPerUnitNorm(
        bytes32 marketKey,
        uint256 size,
        uint256 margin
    ) internal view returns (uint256) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (size == 0 || m.multiplier == 0) return 0;

        uint256 denom = size * m.multiplier;
        return (margin * (10 ** uint256(m.marginDecimals))) / denom;
    }

    /// @dev Long liquidation price in normalized units:
    /// P = (S - A) / (1 - c) => (S-A)*10_000/(10_000 - maintBps)
    function _liqPriceLongNorm(
        uint256 settleNorm,
        uint256 mpuNorm,
        uint256 maintBps
    ) internal pure returns (uint256) {
        if (maintBps >= 10_000) return type(uint256).max;
        if (mpuNorm >= settleNorm) return 0;

        uint256 num = (settleNorm - mpuNorm) * 10_000;
        uint256 den = (10_000 - maintBps);
        return num / den;
    }

    /// @dev Short liquidation price in normalized units:
    /// P = (S + A) / (1 + c) => (S+A)*10_000/(10_000 + maintBps)
    function _liqPriceShortNorm(
        uint256 settleNorm,
        uint256 mpuNorm,
        uint256 maintBps
    ) internal pure returns (uint256) {
        uint256 num = (settleNorm + mpuNorm) * 10_000;
        uint256 den = (10_000 + maintBps);
        return num / den;
    }

    function _normalizePrice(
        uint256 rawPrice,
        uint8 oracleDec,
        uint8 marginDec
    ) internal pure returns (uint256) {
        if (rawPrice == 0) return 0;
        if (oracleDec == marginDec) return rawPrice;

        if (oracleDec < marginDec) {
            return rawPrice * (10 ** uint256(marginDec - oracleDec));
        }

        return rawPrice / (10 ** uint256(oracleDec - marginDec));
    }

    function addMargin(
        bytes32 marketKey,
        uint256 amount
    ) external onlyAccount returns (uint256 newMargin) {
        if (amount == 0) revert InvalidAmount();

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        FuturesTypes.Position storage p = positions[marketKey][msg.sender];
        if (!_isOpen(p)) revert PositionNotActive();

        _rebasePositionToSettlement(marketKey, msg.sender, maxRebaseSteps);

        vault.lockETH(msg.sender, amount);

        p.margin += amount;

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, msg.sender, p.side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, msg.sender, p.side, p.referencePrice);

        emit MarginAdjusted(msg.sender, marketKey, p.side, int256(amount), p.margin);

        return p.margin;
    }

    function releaseExcessMargin(
        bytes32 marketKey
    ) external onlyAccount returns (uint256 released, uint256 newMargin) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        FuturesTypes.Position storage p = positions[marketKey][msg.sender];
        if (!_isOpen(p)) revert PositionNotActive();

        _rebasePositionToSettlement(marketKey, msg.sender, maxRebaseSteps);

        uint256 requiredMargin = _initialMarginRequired(marketKey, p.size);

        if (p.margin <= requiredMargin) revert NoExcessMargin();

        released = p.margin - requiredMargin;
        p.margin = requiredMargin;

        vault.unlockETH(msg.sender, released);

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, msg.sender, p.side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, msg.sender, p.side, p.referencePrice);

        emit MarginAdjusted(msg.sender, marketKey, p.side, -int256(released), p.margin);

        return (released, p.margin);
    }

    function _initialMarginRequired(
        bytes32 marketKey,
        uint256 size
    ) internal view returns (uint256) {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (size == 0) return 0;

        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );

        // required = size * multiplier * settleNorm * initialMarginBps / (10_000 * 10^marginDecimals)
        uint256 denom = 10_000 * (10 ** uint256(m.marginDecimals));
        return (size * m.multiplier * settleNorm * m.initialMarginBps) / denom;
    }

    function _calculateLiquidationPrice(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 size,
        uint256 margin,
        uint256 referencePriceRaw
    ) internal view returns (uint256) {
        _requireLiquidationSide(side);

        if (size == 0) revert InvalidSize();
        if (referencePriceRaw == 0) revert InvalidPrice();

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 referenceNorm = _normalizePrice(
            referencePriceRaw,
            m.oraclePriceDecimals,
            m.marginDecimals
        );

        uint256 marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, size, margin);

        uint256 liquidationNorm;

        if (side == FuturesTypes.PositionSide.Long) {
            liquidationNorm = _liqPriceLongNorm(
                referenceNorm,
                marginPerUnitNorm,
                m.maintenanceMarginBps
            );
        } else {
            liquidationNorm = _liqPriceShortNorm(
                referenceNorm,
                marginPerUnitNorm,
                m.maintenanceMarginBps
            );
        }

        return _denormalizePrice(liquidationNorm, m.oraclePriceDecimals, m.marginDecimals);
    }

    function _denormalizePrice(
        uint256 normalizedPrice,
        uint8 oracleDec,
        uint8 marginDec
    ) internal pure returns (uint256) {
        if (normalizedPrice == 0) return 0;
        if (oracleDec == marginDec) return normalizedPrice;

        if (oracleDec < marginDec) {
            return normalizedPrice / (10 ** uint256(marginDec - oracleDec));
        }

        return normalizedPrice * (10 ** uint256(oracleDec - marginDec));
    }

    function _isOpen(FuturesTypes.Position storage p) internal view returns (bool) {
        return ((p.side == FuturesTypes.PositionSide.Long ||
            p.side == FuturesTypes.PositionSide.Short) && p.size > 0);
    }

    function _requireLiquidationSide(FuturesTypes.PositionSide side) internal pure {
        if (side != FuturesTypes.PositionSide.Long && side != FuturesTypes.PositionSide.Short) {
            revert InvalidPositionSide();
        }
    }

    function _headIsLiquidatable(
        FuturesTypes.PositionSide side,
        uint256 headLiquidationPrice,
        uint256 oraclePrice
    ) internal pure returns (bool) {
        _requireLiquidationSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return oraclePrice <= headLiquidationPrice;
        }

        return oraclePrice >= headLiquidationPrice;
    }

    function _reindexLiquidationPosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requireLiquidationSide(side);
        // Option B: a zero liquidation price is valid only for longs. It means
        // the position is overcollateralized enough that no positive settlement
        // price can liquidate it. Shorts should never calculate to zero here.
        if (liquidationPrice == 0 && side != FuturesTypes.PositionSide.Long) {
            revert InvalidPrice();
        }

        FuturesTypes.Position storage p = positions[marketKey][account];

        uint256 oldLiquidationPrice = p.liquidationPrice;
        uint256 oldTick = p.liquidationTick;

        uint256 tick = _liquidationTickForSide(side, liquidationPrice);

        _positionStore().reindexLiquidationPosition(
            marketKey,
            account,
            side,
            liquidationPrice,
            tick
        );

        p.liquidationPrice = liquidationPrice;
        p.liquidationTick = tick;

        emit LiquidationIndexUpdated(
            marketKey,
            account,
            side,
            oldLiquidationPrice,
            liquidationPrice,
            oldTick,
            tick
        );
    }

    function _clearLiquidationPosition(bytes32 marketKey, address account) internal {
        _positionStore().clearLiquidationPosition(marketKey, account);

        FuturesTypes.Position storage p = positions[marketKey][account];
        p.liquidationPrice = 0;
        p.liquidationTick = 0;
    }

    function _isLosingReferencePrice(
        FuturesTypes.PositionSide side,
        uint256 referencePrice,
        uint256 settlementPrice
    ) internal pure returns (bool) {
        _requireLiquidationSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return referencePrice > settlementPrice;
        }

        return referencePrice < settlementPrice;
    }

    function _referenceTickForSide(
        FuturesTypes.PositionSide side,
        uint256 referencePrice
    ) internal view returns (uint256) {
        uint256 tickSize = tickForLiquidationPrice(referencePrice);

        if (side == FuturesTypes.PositionSide.Long) {
            return (referencePrice + tickSize - 1) / tickSize;
        }

        if (side == FuturesTypes.PositionSide.Short) {
            return referencePrice / tickSize;
        }

        revert InvalidPositionSide();
    }

    function _clearReferencePricePosition(bytes32 marketKey, address account) internal {
        _positionStore().clearReferencePricePosition(marketKey, account);
    }

    function _reindexReferencePricePosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 referencePrice
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requireLiquidationSide(side);
        if (referencePrice == 0) revert InvalidPrice();

        FuturesTypes.ReferencePriceNode memory oldNode = _positionStore().getReferencePriceNode(
            marketKey,
            account
        );

        uint256 oldReferencePrice = oldNode.referencePrice;
        uint256 oldTick = oldNode.referenceTick;

        uint256 tick = _referenceTickForSide(side, referencePrice);

        _positionStore().reindexReferencePricePosition(
            marketKey,
            account,
            side,
            referencePrice,
            tick
        );

        emit ReferencePriceIndexUpdated(
            marketKey,
            account,
            side,
            oldReferencePrice,
            referencePrice,
            oldTick,
            tick
        );
    }

    function _floorLog10(uint256 x) internal pure returns (uint256 r) {
        // x > 0 assumed by callers
        while (x >= 10) {
            x /= 10;
            unchecked {
                r++;
            }
        }
    }

    function _pow10(uint256 exp) internal pure returns (uint256 r) {
        r = 1;
        for (uint256 i = 0; i < exp; ) {
            r *= 10;
            unchecked {
                i++;
            }
        }
    }

    function _oppositeSide(
        FuturesTypes.PositionSide side
    ) internal pure returns (FuturesTypes.PositionSide) {
        _requireLiquidationSide(side);

        return
            side == FuturesTypes.PositionSide.Long
                ? FuturesTypes.PositionSide.Short
                : FuturesTypes.PositionSide.Long;
    }

    function _correctPositivePnlForImbalance(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 positionSize,
        uint256 rawProfit
    ) internal view returns (uint256 correctedProfit, uint256 liquidationBufferPortion) {
        _requireLiquidationSide(side);

        if (rawProfit == 0 || positionSize == 0) {
            return (rawProfit, 0);
        }

        uint256 longs = totalLongs[marketKey];
        uint256 shorts = totalShorts[marketKey];

        uint256 winningOpenInterest;
        uint256 oppositeOpenInterest;

        if (side == FuturesTypes.PositionSide.Long) {
            winningOpenInterest = longs;
            oppositeOpenInterest = shorts;
        } else {
            winningOpenInterest = shorts;
            oppositeOpenInterest = longs;
        }

        if (winningOpenInterest == 0 || winningOpenInterest <= oppositeOpenInterest) {
            return (rawProfit, 0);
        }

        uint256 normalCovered = (rawProfit * oppositeOpenInterest) / winningOpenInterest;

        uint256 bufferShare =
            (liquidationSettlementBuffer[marketKey] * positionSize) / winningOpenInterest;

        correctedProfit = normalCovered + bufferShare;

        if (correctedProfit > rawProfit) {
            correctedProfit = rawProfit;
        }

        if (correctedProfit > normalCovered) {
            liquidationBufferPortion = correctedProfit - normalCovered;
        }
    }

    function _nonLiquidationSettlementAvailable(bytes32 marketKey) internal view returns (uint256) {
        uint256 settlementLocked = vault.settlementEthLocked(marketKey);
        uint256 liquidationBuffer = liquidationSettlementBuffer[marketKey];

        if (settlementLocked <= liquidationBuffer) {
            return 0;
        }

        return settlementLocked - liquidationBuffer;
    }

    function _correctedProfitPaymentCapacity(
        bytes32 marketKey,
        uint256 correctedProfit,
        uint256 normalPart,
        uint256 liquidationBufferPortion
    ) internal view returns (uint256) {
        uint256 normalAvailable = _nonLiquidationSettlementAvailable(marketKey);

        if (normalAvailable < normalPart) {
            return normalAvailable;
        }

        uint256 usableLiquidationBuffer = liquidationBufferPortion;
        uint256 currentBuffer = liquidationSettlementBuffer[marketKey];

        if (usableLiquidationBuffer > currentBuffer) {
            usableLiquidationBuffer = currentBuffer;
        }

        uint256 capacity = normalPart + usableLiquidationBuffer;

        if (capacity > correctedProfit) {
            return correctedProfit;
        }

        return capacity;
    }

    function _consumeLiquidationSettlementBuffer(
        bytes32 marketKey,
        uint256 paid,
        uint256 correctedProfit,
        uint256 liquidationBufferPortion
    ) internal {
        if (paid == 0 || liquidationBufferPortion == 0) {
            return;
        }

        uint256 normalPart = correctedProfit - liquidationBufferPortion;

        if (paid <= normalPart) {
            return;
        }

        uint256 bufferUsed = paid - normalPart;
        uint256 currentBuffer = liquidationSettlementBuffer[marketKey];

        if (bufferUsed > currentBuffer) {
            bufferUsed = currentBuffer;
        }

        if (bufferUsed == 0) {
            return;
        }

        liquidationSettlementBuffer[marketKey] = currentBuffer - bufferUsed;

        emit LiquidationSettlementBufferUsed(
            marketKey,
            bufferUsed,
            liquidationSettlementBuffer[marketKey]
        );
    }

    function _rebasePositionToSettlement(
        bytes32 marketKey,
        address account,
        uint256 maxLoserSteps
    ) internal returns (int256 pnlApplied) {
        FuturesTypes.Position storage p = positions[marketKey][account];

        if (!_isOpen(p)) return 0;

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        if (p.referencePrice == settlementPrice) {
            return 0;
        }

        pnlApplied = _computePnLFromReference(
            marketKey,
            p.side,
            p.size,
            p.referencePrice,
            settlementPrice
        );

        if (pnlApplied < 0) {
            uint256 loss = uint256(-pnlApplied);

            uint256 collected = loss;
            if (collected > p.margin) {
                collected = p.margin;
            }

            if (collected > 0) {
                p.margin -= collected;

                vault.collectToSettlement(
                    marketKey,
                    account,
                    address(0),
                    collected,
                    "futures_position_rebase_loss"
                );
            }

            if (collected < loss) {
                pnlApplied = -int256(collected);
            }
        } else if (pnlApplied > 0) {
            uint256 rawProfit = uint256(pnlApplied);

            (
                uint256 correctedProfit,
                uint256 liquidationBufferPortion
            ) = _correctPositivePnlForImbalance(marketKey, p.side, p.size, rawProfit);

            uint256 normalPart = correctedProfit - liquidationBufferPortion;

            FuturesTypes.PositionSide losingSide = _oppositeSide(p.side);

            if (_nonLiquidationSettlementAvailable(marketKey) < normalPart) {
                _rebaseLosersFromHead(
                    marketKey,
                    losingSide,
                    liquidationSettlementBuffer[marketKey] + normalPart,
                    maxLoserSteps
                );
            }

            uint256 paid = _correctedProfitPaymentCapacity(
                marketKey,
                correctedProfit,
                normalPart,
                liquidationBufferPortion
            );

            if (paid > 0) {
                vault.payFromFuturesSettlementLocked(
                    marketKey,
                    account,
                    paid,
                    "futures_position_rebase_profit"
                );

                p.margin += paid;

                _consumeLiquidationSettlementBuffer(
                    marketKey,
                    paid,
                    correctedProfit,
                    liquidationBufferPortion
                );
            }

            if (correctedProfit < rawProfit || liquidationBufferPortion > 0) {
                emit PositivePnlCorrectedForImbalance(
                    account,
                    marketKey,
                    p.side,
                    rawProfit,
                    correctedProfit,
                    paid,
                    liquidationBufferPortion,
                    totalLongs[marketKey],
                    totalShorts[marketKey]
                );
            }

            if (paid < rawProfit) {
                pnlApplied = int256(paid);
            }
        }

        p.referencePrice = settlementPrice;

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, account, p.side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, account, p.side, p.referencePrice);

        emit PositionSettled(
            account,
            marketKey,
            p.side == FuturesTypes.PositionSide.Long,
            pnlApplied,
            p.margin
        );
    }

    function _rebaseLosersFromHead(
        bytes32 marketKey,
        FuturesTypes.PositionSide losingSide,
        uint256 requiredAmount,
        uint256 maxSteps
    ) internal {
        _requireLiquidationSide(losingSide);

        if (maxSteps == 0) return;

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        uint256 steps;

        while (vault.settlementEthLocked(marketKey) < requiredAmount && steps < maxSteps) {
            address account = _positionStore().getReferencePriceHead(marketKey, losingSide);

            if (account == address(0)) break;

            FuturesTypes.ReferencePriceNode memory node = _positionStore().getReferencePriceNode(
                marketKey,
                account
            );

            if (!node.active || node.side != losingSide) {
                _clearReferencePricePosition(marketKey, account);
                steps++;
                continue;
            }

            if (!_isLosingReferencePrice(losingSide, node.referencePrice, settlementPrice)) {
                break;
            }

            uint256 collected = _rebaseLoserToSettlement(
                marketKey,
                account,
                losingSide,
                settlementPrice
            );

            steps++;

            if (collected == 0) {
                break;
            }
        }
    }

    function rebaseLosingPositionsToBufferTarget(
        bytes32 marketKey,
        FuturesTypes.PositionSide losingSide,
        uint256 targetSettlementBuffer,
        uint256 maxSteps
    )
        external
        returns (
            uint256 scanned,
            uint256 rebased,
            uint256 amountCollected,
            uint256 settlementBufferAfter
        )
    {
        _requireLiquidationSide(losingSide);

        uint256 effectiveMaxSteps = maxSteps;
        if (effectiveMaxSteps == 0) revert InvalidAmount();

        if (effectiveMaxSteps > maxTreasuryRebaseSteps) {
            effectiveMaxSteps = maxTreasuryRebaseSteps;
        }

        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        while (scanned < effectiveMaxSteps) {
            if (
                targetSettlementBuffer > 0 &&
                vault.settlementEthLocked(marketKey) >= targetSettlementBuffer
            ) {
                break;
            }

            address account = _positionStore().getReferencePriceHead(marketKey, losingSide);

            if (account == address(0)) break;

            FuturesTypes.ReferencePriceNode memory node = _positionStore().getReferencePriceNode(
                marketKey,
                account
            );

            if (!node.active || node.side != losingSide) {
                _clearReferencePricePosition(marketKey, account);
                scanned++;
                continue;
            }

            if (!_isLosingReferencePrice(losingSide, node.referencePrice, settlementPrice)) {
                break;
            }

            uint256 collected = _rebaseLoserToSettlement(
                marketKey,
                account,
                losingSide,
                settlementPrice
            );

            scanned++;

            if (collected > 0) {
                rebased++;
                amountCollected += collected;
            } else {
                break;
            }
        }

        settlementBufferAfter = vault.settlementEthLocked(marketKey);

        emit LosingPositionsRebased(
            marketKey,
            losingSide,
            msg.sender,
            scanned,
            rebased,
            amountCollected,
            settlementBufferAfter
        );
    }

    function _rebaseLoserToSettlement(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide expectedLosingSide,
        uint256 settlementPrice
    ) internal returns (uint256 collected) {
        FuturesTypes.Position storage p = positions[marketKey][account];

        if (!_isOpen(p)) return 0;
        if (p.side != expectedLosingSide) return 0;
        if (p.referencePrice == settlementPrice) return 0;

        int256 pnl = _computePnLFromReference(
            marketKey,
            p.side,
            p.size,
            p.referencePrice,
            settlementPrice
        );

        // This helper only collects losers.
        // If the position is not losing, only update/reindex if needed outside this helper.
        if (pnl >= 0) {
            return 0;
        }

        uint256 loss = uint256(-pnl);

        collected = loss;
        if (collected > p.margin) {
            collected = p.margin;
        }

        if (collected > 0) {
            p.margin -= collected;

            vault.collectToSettlement(
                marketKey,
                account,
                address(0),
                collected,
                "futures_rebase_loser_to_buffer"
            );
        }

        p.referencePrice = settlementPrice;

        if (p.margin == 0) {
            // Keep the position for now; liquidation will decide whether it must close.
            // It will almost certainly be liquidatable, but do not delete it here.
        }

        uint256 liquidationPrice = _calculateLiquidationPrice(
            marketKey,
            p.side,
            p.size,
            p.margin,
            p.referencePrice
        );

        _reindexLiquidationPosition(marketKey, account, p.side, liquidationPrice);
        _reindexReferencePricePosition(marketKey, account, p.side, p.referencePrice);

        emit PositionSettled(
            account,
            marketKey,
            p.side == FuturesTypes.PositionSide.Long,
            -int256(collected),
            p.margin
        );
    }

    function _isLiquidatableAtSettlement(
        bytes32 marketKey,
        FuturesTypes.Position storage p,
        uint256 settlementPrice
    ) internal view returns (bool) {
        if (!_isOpen(p)) return false;
        if (settlementPrice == 0) revert InvalidPrice();

        int256 pnl = _computePnLFromReference(
            marketKey,
            p.side,
            p.size,
            p.referencePrice,
            settlementPrice
        );

        uint256 liveMargin;

        if (pnl >= 0) {
            liveMargin = p.margin + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            liveMargin = p.margin > loss ? p.margin - loss : 0;
        }

        uint256 maintenanceMargin = maintenanceRequiredAtMark(marketKey, p.size, settlementPrice);

        return liveMargin < maintenanceMargin;
    }

    function getImbalanceOrder(
        bytes32 marketKey
    )
        external
        view
        returns (
            bool active,
            FuturesTypes.PositionSide syntheticMakerSide,
            uint256 amount,
            uint256 settlementPrice
        )
    {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        uint256 longs = totalLongs[marketKey];
        uint256 shorts = totalShorts[marketKey];

        if (longs > shorts) {
            // Market is long-heavy.
            // Synthetic maker is Buy, so real users can Sell/Short into it.
            return (true, FuturesTypes.PositionSide.Long, longs - shorts, settlementPrice);
        }

        if (shorts > longs) {
            // Market is short-heavy.
            // Synthetic maker is Sell, so real users can Buy/Long into it.
            return (true, FuturesTypes.PositionSide.Short, shorts - longs, settlementPrice);
        }

        return (false, FuturesTypes.PositionSide.None, 0, settlementPrice);
    }

    function getLiquidationList(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (FuturesTypes.LiquidationList memory) {
        _requireLiquidationSide(side);
        return _positionStore().getLiquidationList(marketKey, side);
    }

    function getLiquidationNode(
        bytes32 marketKey,
        address account
    ) external view returns (FuturesTypes.LiquidationNode memory) {
        return _positionStore().getLiquidationNode(marketKey, account);
    }

    function getReferencePriceList(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (FuturesTypes.ReferencePriceList memory) {
        _requireLiquidationSide(side);
        return _positionStore().getReferencePriceList(marketKey, side);
    }

    function getReferencePriceNode(
        bytes32 marketKey,
        address account
    ) external view returns (FuturesTypes.ReferencePriceNode memory) {
        return _positionStore().getReferencePriceNode(marketKey, account);
    }

    function getReferencePriceTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick
    ) external view returns (address) {
        _requireLiquidationSide(side);
        return _positionStore().getReferencePriceTickAnchor(marketKey, side, tick);
    }

    function positionHealth(
        bytes32 marketKey,
        address account
    )
        external
        view
        returns (
            FuturesTypes.Position memory position,
            int256 unrealizedPnl,
            uint256 liveMargin,
            uint256 maintenanceMargin,
            bool liquidatable
        )
    {
        FuturesTypes.MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 settlementPrice = m.lastSettlementPrice;
        if (settlementPrice == 0) revert InvalidPrice();

        position = positions[marketKey][account];

        if (position.side == FuturesTypes.PositionSide.None || position.size == 0) {
            return (position, 0, 0, 0, false);
        }

        unrealizedPnl = _computePnLFromReference(
            marketKey,
            position.side,
            position.size,
            position.referencePrice,
            settlementPrice
        );

        if (unrealizedPnl >= 0) {
            liveMargin = position.margin + uint256(unrealizedPnl);
        } else {
            uint256 loss = uint256(-unrealizedPnl);
            liveMargin = position.margin > loss ? position.margin - loss : 0;
        }

        maintenanceMargin = maintenanceRequiredAtMark(marketKey, position.size, settlementPrice);

        liquidatable = liveMargin < maintenanceMargin;
    }

    function settlementBuffer(bytes32 marketKey) external view returns (uint256) {
        return vault.settlementEthLocked(marketKey);
    }

    function _readStoredSettlementPrice(
        FuturesTypes.MarketConfig storage m
    ) internal view returns (uint256 rawPrice, uint256 priceTimestamp) {
        (rawPrice, , priceTimestamp, ) = priceManager.getOraclePrice(
            m.oracle,
            PriceManager.OracleContext.FUTURE_SETTLEMENT
        );
    }

    function _tryRefreshSettlementOracle(address oracle) internal {
        try PriceManager(address(priceManager)).fetchPrice(oracle) {} catch {}
        try PriceManager(address(priceManager)).syncOracleData(oracle) {} catch {}
    }

    function getLiquidationTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick
    ) external view returns (address) {
        _requireLiquidationSide(side);
        return _positionStore().getLiquidationTickAnchor(marketKey, side, tick);
    }

    function _liquidationTickForSide(
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice
    ) internal view returns (uint256) {
        _requireLiquidationSide(side);

        if (liquidationPrice == 0) {
            if (side != FuturesTypes.PositionSide.Long) revert InvalidPrice();
            return 0;
        }

        uint256 tickSize = tickForLiquidationPrice(liquidationPrice);

        if (side == FuturesTypes.PositionSide.Long) {
            return (liquidationPrice + tickSize - 1) / tickSize;
        }

        return liquidationPrice / tickSize;
    }
}
