// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { PriceManager } from "../../oracle/PriceManager.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { IPriceOracle } from "../../oracle/interfaces/IPriceOracle.sol";

/// @notice Futures core ledger (ledger-only, no custody moves except for release and add margin).:
/// - Markets & parameters
/// - User positions (long/short per market)
/// - Buffers (accounting only): imbalanceBuffer, liquidationBuffer
/// - NO vault calls (custody handled by OrderBook + SettlementManager)
///
/// Settlement model:
/// - Trades do NOT require settlement / PnL realization.
/// - Position PnL is referenced to the market's lastSettlementPrice ("index").
/// - SettlementManager can iterate and settle positions when desired.
/// - Liquidation uses marginLive = margin + unrealizedPnL(index -> mark) without mutating.
///
/// Efficiency (Approach A):
/// - Store per-position marginPerUnitNorm (normalized "price buffer per unit").
/// - Store market-wide minMarginPerUnitNorm per side (only decreases; approximate).
/// - From these, SettlementManager can compute conservative "no-liquidation band"
///   at any new mark price without looping.
contract FuturesContract is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    // -------- Errors --------
    error NotRegisteredAccount();
    error OrderBookOnly();
    error SettlementManagerOnly();
    error EngineOnly();

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
    error NeedBothSides();
    error ZeroSize();

    error InsufficientMargin();
    error OldSettlementMissing();
    error ZeroCredit();
    error InvalidAmount();
    error NotLiquidatable();
    error NoMargin();
    error NoExcessMargin();

    // -------- Roles --------
    bytes32 public constant MARKET_MANAGER_ROLE = keccak256("MARKET_MANAGER_ROLE");
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");
    bytes32 public constant SETTLEMENT_MANAGER_ROLE = keccak256("SETTLEMENT_MANAGER_ROLE");

    // -------- External refs --------
    AccountRegistry public immutable accountRegistry;
    SethxVault public immutable vault;
    PriceManager public priceManager;

    // -------- Data structs --------
    struct MarketConfig {
        string ticker;
        address oracle;
        uint8 oraclePriceDecimals;
        uint8 marginDecimals; // always 18 for ETH
        uint256 initialMarginBps;
        uint256 maintenanceMarginBps;
        uint256 multiplier;
        uint256 lastSettlementPrice;
        uint256 lastSettlementBlock;
        uint256 minMarginPerUnitLongNorm;
        uint256 minMarginPerUnitShortNorm;
    }

    struct Position {
        uint256 size; // base-size units
        uint256 margin; // ETH wei - realized ONLY through settlement rounds
        uint256 marginPerUnitNorm; // normalized "price buffer per unit" used for liquidation threshold computation
        bool isActive;
    }

    // -------- Storage --------
    mapping(bytes32 => MarketConfig) public markets;

    // -------- Market index (for frontends) --------
    bytes32[] private _marketKeys;
    mapping(bytes32 => uint256) private _marketKeyIndexPlus1; // 0 means not present

    /// @notice whether a market is currently open for new exposure (order placement/matching to open/increase).
    /// Close/reduce orders should still be possible when closed (enforced in OrderBook; ledger allows reduce always).
    mapping(bytes32 => bool) public marketActive;

    /// positions[user][marketKey][isLong]
    mapping(address => mapping(bytes32 => mapping(bool => Position))) public positions;

    /// Open interest totals (size units)
    mapping(bytes32 => uint256) public totalLongs;
    mapping(bytes32 => uint256) public totalShorts;

    /// Buffers (accounting only)
    mapping(bytes32 => uint256) public imbalanceBuffer;
    mapping(bytes32 => uint256) public liquidationBuffer;

    mapping(bytes32 => EnumerableSet.AddressSet) private longHolders;
    mapping(bytes32 => EnumerableSet.AddressSet) private shortHolders;

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
        bool isLong,
        int256 delta,
        uint256 newMargin
    );

    event PositionsNetted(
        address indexed user,
        bytes32 indexed marketKey,
        uint256 newSize,
        bool newIsLong,
        uint256 mergedMargin
    );

    event PositionSettled(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        int256 pnlApplied,
        uint256 newMargin
    );

    /// @dev emitted by settlePositionCapped() to make “cap vs theoretical” visible to SM
    event PositionSettledCapped(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        int256 pnlTheoretical,
        int256 pnlApplied,
        uint256 maxLossCollectible,
        uint256 uncollectedLoss,
        uint256 newMargin
    );

    /// @dev emitted by settlePositionCredit() for explicit credit (winner payout)
    event PositionCredited(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        uint256 creditAmount,
        uint256 newMargin
    );

    event Liquidated(
        address indexed user,
        bytes32 indexed marketKey,
        bool isLong,
        uint256 size,
        uint256 rawPrice,
        uint256 seizedMarginToLiqBuffer
    );

    event ImbalanceBufferFunded(bytes32 indexed marketKey, uint256 amount, string reason);
    event LiquidationBufferFunded(bytes32 indexed marketKey, uint256 amount, string reason);

    event ImbalanceBufferUsed(bytes32 indexed marketKey, uint256 amount);
    event LiquidationBufferUsed(bytes32 indexed marketKey, uint256 amount);

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

    modifier onlySettlementManager() {
        if (!hasRole(SETTLEMENT_MANAGER_ROLE, msg.sender)) revert SettlementManagerOnly();
        _;
    }

    modifier onlyEngineNetting() {
        if (!hasRole(ORDERBOOK_ROLE, msg.sender) && !hasRole(SETTLEMENT_MANAGER_ROLE, msg.sender))
            revert EngineOnly();
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

    function setSettlementManager(address settlementManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (settlementManager == address(0)) revert ZeroAddress();
        _grantRole(SETTLEMENT_MANAGER_ROLE, settlementManager);
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
    ) external onlyRole(MARKET_MANAGER_ROLE) returns (bytes32 marketKey) {
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

        markets[marketKey] = MarketConfig({
            ticker: ticker,
            oracle: oracle,
            oraclePriceDecimals: oracleDecimals,
            marginDecimals: marginDecimals,
            initialMarginBps: initialMarginBps,
            maintenanceMarginBps: maintenanceMarginBps,
            multiplier: multiplier,
            lastSettlementPrice: initialPriceRaw,
            lastSettlementBlock: block.number,
            minMarginPerUnitLongNorm: 0,
            minMarginPerUnitShortNorm: 0
        });

        marketActive[marketKey] = true;

        // Index this market key for discovery (frontends/tests)
        _marketKeys.push(marketKey);
        _marketKeyIndexPlus1[marketKey] = _marketKeys.length; // 1-based

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

    function closeMarket(bytes32 marketKey) external onlyRole(MARKET_MANAGER_ROLE) {
        if (markets[marketKey].oracle == address(0)) revert UnknownMarket();
        if (!marketActive[marketKey]) revert MarketAlreadyClosed();
        marketActive[marketKey] = false;
        emit MarketClosed(marketKey);
    }

    function reopenMarket(bytes32 marketKey) external onlyRole(MARKET_MANAGER_ROLE) {
        MarketConfig storage m = markets[marketKey];
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
        MarketConfig storage m = markets[marketKey];
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

    /// @notice SettlementManager updates market settlement/index price (raw oracle price).
    /// @dev This does NOT touch positions. Position PnL is realized only when SM iterates.
    function setLastSettlementPrice(
        bytes32 marketKey,
        uint256 newPriceRaw
    ) external onlySettlementManager {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (newPriceRaw == 0) revert InvalidPrice();

        m.lastSettlementPrice = newPriceRaw;
        m.lastSettlementBlock = block.number;

        emit MarketPriceUpdated(marketKey, newPriceRaw, block.number);
    }

    // -------- Positions (OrderBook only) --------
    // IMPORTANT: No checkpointing / no PnL realization here by design.

    /// @notice Open/increase a position (ledger only). Custody locking is done in OrderBook.
    /// @dev Requires marketActive to open/increase exposure.
    function openPosition(
        address user,
        bytes32 marketKey,
        uint256 sizeDelta,
        uint256 marginDelta,
        bool isLong
    ) external onlyOrderBook {
        if (user == address(0)) revert InvalidUser();
        if (sizeDelta == 0) revert InvalidSize();

        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (!marketActive[marketKey]) revert MarketIsClosed();

        Position storage p = positions[user][marketKey][isLong];

        if (!p.isActive) {
            p.isActive = true;
            if (isLong) longHolders[marketKey].add(user);
            else shortHolders[marketKey].add(user);
        }

        p.size += sizeDelta;
        p.margin += marginDelta;

        // Update margin-per-unit (for liquidation threshold computation)
        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        if (isLong) totalLongs[marketKey] += sizeDelta;
        else totalShorts[marketKey] += sizeDelta;

        emit PositionOpened(user, marketKey, sizeDelta, marginDelta, isLong);
    }

    /// @notice Reduce a position size (ledger only). Always allowed even if marketActive=false.
    /// @dev Custody unlocking is done in OrderBook.
    function reducePosition(
        address user,
        bytes32 marketKey,
        uint256 amount,
        bool isLong
    ) external onlyOrderBook {
        if (user == address(0)) revert InvalidUser();
        if (amount == 0) revert InvalidReduction();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive || p.size < amount) revert InvalidPosition();

        p.size -= amount;

        if (isLong) totalLongs[marketKey] -= amount;
        else totalShorts[marketKey] -= amount;

        if (p.size == 0) {
            // close position
            p.isActive = false;
            p.margin = 0;
            p.marginPerUnitNorm = 0;

            if (isLong) longHolders[marketKey].remove(user);
            else shortHolders[marketKey].remove(user);

            emit PositionReduced(user, marketKey, amount, isLong);
            return;
        }

        // Recompute margin-per-unit
        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit PositionReduced(user, marketKey, amount, isLong);
    }

    /// @notice Ledger-only margin adjustment driven by the OrderBook.
    /// Always allowed even if marketActive=false.
    function adjustMargin(
        address user,
        bytes32 marketKey,
        bool isLong,
        int256 delta
    ) external onlyOrderBook returns (uint256 newMargin) {
        if (user == address(0)) revert InvalidUser();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) revert PositionNotActive();

        if (delta >= 0) {
            p.margin += uint256(delta);
        } else {
            uint256 d = uint256(-delta);
            if (p.margin < d) revert InsufficientMargin();
            p.margin -= d;
        }

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit MarginAdjusted(user, marketKey, isLong, delta, p.margin);
        return p.margin;
    }

    // -------- Netting (merge margins, net sizes) --------

    function netPositions(bytes32 marketKey) external onlyAccount {
        _netPositions(msg.sender, marketKey);
    }

    function netPositionsFor(address user, bytes32 marketKey) external onlyEngineNetting {
        _netPositions(user, marketKey);
    }

    function _netPositions(address user, bytes32 marketKey) internal {
        Position storage L = positions[user][marketKey][true];
        Position storage S = positions[user][marketKey][false];

        if (!L.isActive || !S.isActive) revert NeedBothSides();
        if (L.size == 0 || S.size == 0) revert ZeroSize();

        uint256 longSize = L.size;
        uint256 shortSize = S.size;

        uint256 cancelSize = longSize < shortSize ? longSize : shortSize;

        totalLongs[marketKey] -= cancelSize;
        totalShorts[marketKey] -= cancelSize;

        uint256 mergedMargin = L.margin + S.margin;

        if (longSize == shortSize) {
            // Close both
            L.size = 0;
            L.margin = 0;
            L.marginPerUnitNorm = 0;
            L.isActive = false;

            S.size = 0;
            S.margin = 0;
            S.marginPerUnitNorm = 0;
            S.isActive = false;

            longHolders[marketKey].remove(user);
            shortHolders[marketKey].remove(user);

            emit PositionsNetted(user, marketKey, 0, true, mergedMargin);
            return;
        }

        if (longSize > shortSize) {
            uint256 newSize = longSize - shortSize;

            // Short closes
            S.size = 0;
            S.margin = 0;
            S.marginPerUnitNorm = 0;
            S.isActive = false;
            shortHolders[marketKey].remove(user);

            // Long survives with merged margin
            L.size = newSize;
            L.margin = mergedMargin;
            L.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, L.size, L.margin);
            _updateApproxMinMarginPerUnit(marketKey, true, L.marginPerUnitNorm);

            emit PositionsNetted(user, marketKey, newSize, true, mergedMargin);
        } else {
            uint256 newSize = shortSize - longSize;

            // Long closes
            L.size = 0;
            L.margin = 0;
            L.marginPerUnitNorm = 0;
            L.isActive = false;
            longHolders[marketKey].remove(user);

            // Short survives with merged margin
            S.size = newSize;
            S.margin = mergedMargin;
            S.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, S.size, S.margin);
            _updateApproxMinMarginPerUnit(marketKey, false, S.marginPerUnitNorm);

            emit PositionsNetted(user, marketKey, newSize, false, mergedMargin);
        }
    }

    // =========================================================
    // Settlement primitives (SettlementManager only)
    // =========================================================

    /// @notice Realize *theoretical* PnL for oldSettlementRaw -> newSettlementRaw and apply it to margin.
    /// @dev This mutates position margin and updates marginPerUnitNorm.
    function settlePosition(
        bytes32 marketKey,
        address user,
        bool isLong,
        uint256 newSettlementRaw
    ) external onlySettlementManager returns (int256 pnlApplied, uint256 newMargin) {
        (pnlApplied, newMargin) = _settlePositionInternal(
            marketKey,
            user,
            isLong,
            newSettlementRaw
        );
        return (pnlApplied, newMargin);
    }

    /// @notice SettlementManager loss-collection helper.
    ///
    /// Applies settlement PnL, but if the theoretical PnL is a LOSS, it is capped so that:
    /// - The loss applied to the ledger is at most maxLossCollectible.
    /// - This matches the vault collection cap used by SettlementManager.
    ///
    /// Returns:
    /// - pnlApplied: signed pnl actually applied (<= theoretical loss magnitude if negative).
    /// - newMargin: resulting stored margin (clamped at 0).
    /// - uncollectedLoss: (theoreticalLoss - appliedLoss) if loss was capped; otherwise 0.
    function settlePositionCapped(
        bytes32 marketKey,
        address user,
        bool isLong,
        uint256 newSettlementRaw,
        uint256 maxLossCollectible
    )
        external
        onlySettlementManager
        returns (int256 pnlApplied, uint256 newMargin, uint256 uncollectedLoss)
    {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (newSettlementRaw == 0) revert InvalidPrice();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) revert PositionInactive();

        uint256 oldRaw = m.lastSettlementPrice;
        if (oldRaw == 0) revert OldSettlementMissing();

        int256 pnlTheo = _computePnLFromSettlementMove(
            marketKey,
            isLong,
            p.size,
            oldRaw,
            newSettlementRaw
        );

        // If it's profit or zero: apply full (no cap).
        if (pnlTheo >= 0) {
            p.margin += uint256(pnlTheo);
            p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
            _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

            emit PositionSettled(user, marketKey, isLong, pnlTheo, p.margin);
            emit PositionSettledCapped(
                user,
                marketKey,
                isLong,
                pnlTheo,
                pnlTheo,
                maxLossCollectible,
                0,
                p.margin
            );
            return (pnlTheo, p.margin, 0);
        }

        // Loss path: cap by maxLossCollectible
        uint256 lossTheo = uint256(-pnlTheo);
        uint256 lossApply = lossTheo;

        if (maxLossCollectible < lossApply) {
            lossApply = maxLossCollectible;
            uncollectedLoss = lossTheo - lossApply;
        } else {
            uncollectedLoss = 0;
        }

        pnlApplied = -int256(lossApply);

        if (lossApply == 0) {
            // nothing to apply
        } else if (p.margin >= lossApply) {
            p.margin -= lossApply;
        } else {
            // ledger margin clamps to 0 (underfund tracked externally in SM)
            p.margin = 0;
        }

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit PositionSettled(user, marketKey, isLong, pnlApplied, p.margin);
        emit PositionSettledCapped(
            user,
            marketKey,
            isLong,
            pnlTheo,
            pnlApplied,
            maxLossCollectible,
            uncollectedLoss,
            p.margin
        );

        return (pnlApplied, p.margin, uncollectedLoss);
    }

    /// @notice SettlementManager profit payout helper.
    /// Credits a specific amount directly to margin (no price math).
    /// @dev Used to distribute "effectiveProfitPaid" from the settlement pool pro-rata.
    function settlePositionCredit(
        bytes32 marketKey,
        address user,
        bool isLong,
        uint256 creditAmount
    ) external onlySettlementManager returns (uint256 newMargin) {
        if (creditAmount == 0) revert ZeroCredit();

        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) revert PositionInactive();

        p.margin += creditAmount;

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit PositionCredited(user, marketKey, isLong, creditAmount, p.margin);
        return p.margin;
    }

    /// @notice Liquidate a position at a given mark price (raw oracle price).
    /// Uses marginLive = margin + unrealizedPnL(settlement -> mark) without mutating,
    /// checks maintenance, then closes and moves *stored* margin into liquidationBuffer (accounting).
    ///
    /// @dev This function does NOT auto-realize unrealized pnl into margin before liquidation.
    /// Liquidation seizes the current stored margin as-is; SettlementManager handles custody/deficits externally.
    function liquidatePosition(
        bytes32 marketKey,
        address user,
        bool isLong,
        uint256 markRawPrice
    ) external onlySettlementManager returns (uint256 seizedMargin, uint256 liqSize) {
        if (markRawPrice == 0) revert InvalidPrice();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) revert PositionInactive();

        if (!_isLiquidatableDirect(p, marketKey, isLong, markRawPrice)) {
            revert NotLiquidatable();
        }
        return _liquidate(user, marketKey, isLong, markRawPrice);
    }

    // -------- Buffers (accounting only) --------

    function useLiquidationBuffer(
        bytes32 marketKey,
        uint256 amount
    ) external onlySettlementManager returns (uint256 used) {
        uint256 avail = liquidationBuffer[marketKey];
        used = avail >= amount ? amount : avail;
        if (used > 0) {
            liquidationBuffer[marketKey] -= used;
            emit LiquidationBufferUsed(marketKey, used);
        }
    }

    function useImbalanceBuffer(
        bytes32 marketKey,
        uint256 amount
    ) external onlySettlementManager returns (uint256 used) {
        uint256 avail = imbalanceBuffer[marketKey];
        used = avail >= amount ? amount : avail;
        if (used > 0) {
            imbalanceBuffer[marketKey] -= used;
            emit ImbalanceBufferUsed(marketKey, used);
        }
    }

    function fundImbalanceBuffer(
        bytes32 marketKey,
        uint256 amount,
        string calldata reason
    ) external onlySettlementManager {
        if (amount == 0) revert InvalidAmount();
        imbalanceBuffer[marketKey] += amount;
        emit ImbalanceBufferFunded(marketKey, amount, reason);
    }

    function fundLiquidationBuffer(
        bytes32 marketKey,
        uint256 amount,
        string calldata reason
    ) external onlySettlementManager {
        if (amount == 0) revert InvalidAmount();
        liquidationBuffer[marketKey] += amount;
        emit LiquidationBufferFunded(marketKey, amount, reason);
    }

    // -------- Views --------

    function getMarket(bytes32 marketKey) external view returns (MarketConfig memory) {
        return markets[marketKey];
    }

    function getPosition(
        address user,
        bytes32 marketKey,
        bool isLong
    ) external view returns (Position memory) {
        return positions[user][marketKey][isLong];
    }

    function getLongHolders(bytes32 marketKey) external view returns (address[] memory) {
        return longHolders[marketKey].values();
    }

    function getShortHolders(bytes32 marketKey) external view returns (address[] memory) {
        return shortHolders[marketKey].values();
    }

    function getOpenInterestImbalance(bytes32 marketKey) external view returns (int256) {
        return int256(totalLongs[marketKey]) - int256(totalShorts[marketKey]);
    }

    /// @notice Normalize a raw oracle price into ETH margin decimals scale.
    function normalizePrice(bytes32 marketKey, uint256 rawPrice) public view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        return _normalizePrice(rawPrice, m.oraclePriceDecimals, m.marginDecimals);
    }

    /// @notice Unrealized PnL from settlement->mark (ETH margin units, signed) WITHOUT mutating.
    function unrealizedPnLAtMark(
        bytes32 marketKey,
        bool isLong,
        uint256 size,
        uint256 markRawPrice
    ) public view returns (int256) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (markRawPrice == 0) revert InvalidPrice();

        return
            _computePnLFromSettlementMove(
                marketKey,
                isLong,
                size,
                m.lastSettlementPrice,
                markRawPrice
            );
    }

    /// @notice Live margin at mark = stored margin + unrealizedPnL(settlement->mark), clamped at 0.
    function marginLiveAtMark(
        address user,
        bytes32 marketKey,
        bool isLong,
        uint256 markRawPrice
    ) public view returns (uint256) {
        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) return 0;

        int256 upnl = unrealizedPnLAtMark(marketKey, isLong, p.size, markRawPrice);
        if (upnl >= 0) return p.margin + uint256(upnl);

        uint256 loss = uint256(-upnl);
        if (p.margin <= loss) return 0;
        return p.margin - loss;
    }

    /// @notice Maintenance requirement at mark for a given size (ETH units).
    function maintenanceRequiredAtMark(
        bytes32 marketKey,
        uint256 size,
        uint256 markRawPrice
    ) public view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 priceNorm = _normalizePrice(markRawPrice, m.oraclePriceDecimals, m.marginDecimals);
        uint256 denom = 10_000 * (10 ** uint256(m.marginDecimals));

        return (size * m.multiplier * priceNorm * m.maintenanceMarginBps) / denom;
    }

    /// @notice Approach A: conservative "skip scan" using min margin-per-unit bounds.
    function canSkipLiquidationScan(
        bytes32 marketKey,
        uint256 markRawPrice
    ) external view returns (bool) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        uint256 priceNorm = _normalizePrice(markRawPrice, m.oraclePriceDecimals, m.marginDecimals);
        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );

        uint256 cBps = m.maintenanceMarginBps;

        bool noLongs = true;
        if (m.minMarginPerUnitLongNorm != 0) {
            uint256 maxLongLiq = _liqPriceLongNorm(settleNorm, m.minMarginPerUnitLongNorm, cBps);
            noLongs = (priceNorm > maxLongLiq);
        }

        bool noShorts = true;
        if (m.minMarginPerUnitShortNorm != 0) {
            uint256 minShortLiq = _liqPriceShortNorm(settleNorm, m.minMarginPerUnitShortNorm, cBps);
            noShorts = (priceNorm < minShortLiq);
        }

        return noLongs && noShorts;
    }

    function getApproxMinMarginPerUnit(
        bytes32 marketKey
    ) external view returns (uint256 minLong, uint256 minShort) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        return (m.minMarginPerUnitLongNorm, m.minMarginPerUnitShortNorm);
    }

    // -------- Internal: liquidation logic --------

    function _isLiquidatableDirect(
        Position storage p,
        bytes32 marketKey,
        bool isLong,
        uint256 markRawPrice
    ) internal view returns (bool) {
        MarketConfig storage m = markets[marketKey];

        int256 upnl = _computePnLFromSettlementMove(
            marketKey,
            isLong,
            p.size,
            m.lastSettlementPrice,
            markRawPrice
        );

        uint256 live;
        if (upnl >= 0) {
            live = p.margin + uint256(upnl);
        } else {
            uint256 loss = uint256(-upnl);
            live = (p.margin <= loss) ? 0 : (p.margin - loss);
        }

        uint256 req = maintenanceRequiredAtMark(marketKey, p.size, markRawPrice);
        return live < req;
    }

    /// @dev Liquidation (ledger only):
    /// - closes position
    /// - moves remaining stored margin into liquidationBuffer (accounting)
    function _liquidate(
        address user,
        bytes32 marketKey,
        bool isLong,
        uint256 markRawPrice
    ) internal returns (uint256 seizedMargin, uint256 liqSize) {
        Position storage p = positions[user][marketKey][isLong];

        liqSize = p.size;
        seizedMargin = p.margin;

        p.size = 0;
        p.margin = 0;
        p.marginPerUnitNorm = 0;
        p.isActive = false;

        if (isLong) {
            totalLongs[marketKey] -= liqSize;
            longHolders[marketKey].remove(user);
        } else {
            totalShorts[marketKey] -= liqSize;
            shortHolders[marketKey].remove(user);
        }

        if (seizedMargin > 0) {
            liquidationBuffer[marketKey] += seizedMargin;
            emit LiquidationBufferFunded(marketKey, seizedMargin, "Liquidation seized margin");
        }

        emit PositionReduced(user, marketKey, liqSize, isLong);
        emit Liquidated(user, marketKey, isLong, liqSize, markRawPrice, seizedMargin);
    }

    // -------- Internal: settlement PnL math --------

    /// @dev PnL from oldRaw -> newRaw referenced to settlement/index move (ETH units).
    function _computePnLFromSettlementMove(
        bytes32 marketKey,
        bool isLong,
        uint256 size,
        uint256 rawOld,
        uint256 rawNew
    ) internal view returns (int256) {
        if (rawOld == rawNew || size == 0) return 0;

        MarketConfig storage m = markets[marketKey];

        uint256 oldN = _normalizePrice(rawOld, m.oraclePriceDecimals, m.marginDecimals);
        uint256 newN = _normalizePrice(rawNew, m.oraclePriceDecimals, m.marginDecimals);

        if (oldN == newN) return 0;

        bool priceUp = newN > oldN;
        uint256 absDelta = priceUp ? (newN - oldN) : (oldN - newN);

        uint256 denom = 10 ** uint256(m.marginDecimals);
        uint256 pnlAbs = (size * m.multiplier * absDelta) / denom;

        bool positive = isLong ? priceUp : !priceUp;
        return positive ? int256(pnlAbs) : -int256(pnlAbs);
    }

    // -------- Internal: margin-per-unit + bounds --------

    /// @dev A = margin * 10^marginDecimals  / (size * multiplier)
    function _computeMarginPerUnitNorm(
        bytes32 marketKey,
        uint256 size,
        uint256 margin
    ) internal view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
        if (size == 0 || m.multiplier == 0) return 0;

        uint256 denom = size * m.multiplier;
        return (margin * (10 ** uint256(m.marginDecimals))) / denom;
    }

    function _updateApproxMinMarginPerUnit(
        bytes32 marketKey,
        bool isLong,
        uint256 mpuNorm
    ) internal {
        if (mpuNorm == 0) return;
        MarketConfig storage m = markets[marketKey];

        if (isLong) {
            if (m.minMarginPerUnitLongNorm == 0 || mpuNorm < m.minMarginPerUnitLongNorm) {
                m.minMarginPerUnitLongNorm = mpuNorm;
            }
        } else {
            if (m.minMarginPerUnitShortNorm == 0 || mpuNorm < m.minMarginPerUnitShortNorm) {
                m.minMarginPerUnitShortNorm = mpuNorm;
            }
        }
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
            uint256 factor = 10 ** uint256(marginDec - oracleDec);
            return rawPrice * factor;
        } else {
            uint256 factor = 10 ** uint256(oracleDec - marginDec);
            return rawPrice / factor; // floors; conservative
        }
    }

    // =========================================================
    // Internal helper used by settlePosition (full theoretical apply)
    // =========================================================

    function _settlePositionInternal(
        bytes32 marketKey,
        address user,
        bool isLong,
        uint256 newSettlementRaw
    ) internal returns (int256 pnlApplied, uint256 newMargin) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();
        if (newSettlementRaw == 0) revert InvalidPrice();

        Position storage p = positions[user][marketKey][isLong];
        if (!p.isActive) revert PositionInactive();

        uint256 oldRaw = m.lastSettlementPrice;
        if (oldRaw == 0) revert OldSettlementMissing();

        pnlApplied = _computePnLFromSettlementMove(
            marketKey,
            isLong,
            p.size,
            oldRaw,
            newSettlementRaw
        );

        if (pnlApplied >= 0) {
            p.margin += uint256(pnlApplied);
        } else {
            uint256 loss = uint256(-pnlApplied);
            if (p.margin >= loss) p.margin -= loss;
            else p.margin = 0;
        }

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit PositionSettled(user, marketKey, isLong, pnlApplied, p.margin);
        return (pnlApplied, p.margin);
    }

    // ---- Account-facing margin management (ledger-only) ----

    function addMargin(
        bytes32 marketKey,
        bool isLong,
        uint256 amount
    ) external onlyAccount returns (uint256 newMargin) {
        if (amount == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        Position storage p = positions[msg.sender][marketKey][isLong];
        if (!p.isActive || p.size == 0) revert PositionNotActive();

        // lock custody in vault first
        vault.lockETH(msg.sender, amount);

        p.margin += amount;

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        emit MarginAdjusted(msg.sender, marketKey, isLong, int256(amount), p.margin);
        return p.margin;
    }

    function releaseExcessMargin(
        bytes32 marketKey,
        bool isLong
    ) external onlyAccount returns (uint256 released, uint256 newMargin) {
        MarketConfig storage m = markets[marketKey];
        if (m.oracle == address(0)) revert UnknownMarket();

        Position storage p = positions[msg.sender][marketKey][isLong];
        if (p.margin == 0) revert NoMargin();

        uint256 requiredMargin = 0;

        // If position is still active, keep only required initial margin.
        if (p.isActive && p.size > 0) {
            requiredMargin = _initialMarginRequiredAtSettlement(marketKey, p.size);
        }

        if (p.margin <= requiredMargin) revert NoExcessMargin();

        released = p.margin - requiredMargin;
        p.margin = requiredMargin;

        if (p.margin == 0 && p.size == 0) {
            p.isActive = false;
        }

        p.marginPerUnitNorm = _computeMarginPerUnitNorm(marketKey, p.size, p.margin);
        _updateApproxMinMarginPerUnit(marketKey, isLong, p.marginPerUnitNorm);

        vault.unlockETH(msg.sender, released);

        emit MarginAdjusted(msg.sender, marketKey, isLong, -int256(released), p.margin);
        return (released, p.margin);
    }

    function _initialMarginRequiredAtSettlement(
        bytes32 marketKey,
        uint256 size
    ) internal view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
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
}
