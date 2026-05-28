// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { FuturesContract } from "./FuturesContract.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

/// @notice Futures OrderBook
/// - Orders are BUY/SELL (not open/close). Execution auto-nets:
///     BUY: close SHORT first, then open/increase LONG
///     SELL: close LONG first, then open/increase SHORT
/// - Margin custody is handled by Vault; FuturesContract holds ledger.
/// - Margin is locked at placement based on lastSettlementPrice.
/// - Fees are locked at placement and treated separately (fixed snapshot; charged on fills).
/// - Additionally, we lock a *fixed* variation/PnL buffer at placement based on (limit price vs settlement)
///   that does NOT change while resting. At match-time, if settlement moved, the buffer may be insufficient.
/// - At match time, we settle variation (execPrice vs current settlement) by transferring from payer’s locked
///   quote collateral to receiver (credit), and we ensure remaining locked collateral can support opening margin.
/// - If not, the unsafe order is cancelled (maker: removed from book; taker: cancelled and stop matching).
///
/// IMPORTANT (single locked pool):
/// - Vault has ONE locked pool per user/token (no per-order pools).
/// - Therefore OrderBook MUST NOT "credit" an order with released close-margin by inflating collateralLocked.
///   Doing so would allow unlocking margin that belongs to positions.
/// - Close-awareness must be handled by reducing required OPEN margin (openAmt = tradeAmt - closeAmt),
///   not by increasing the order's locked pot.
contract FuturesOrderBook is AccessControl {
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant SETTLEMENT_MANAGER_ROLE = keccak256("SETTLEMENT_MANAGER_ROLE");
    bytes32 public constant PASSIVE_MM_PUBLISHER_ROLE = keccak256("PASSIVE_MM_PUBLISHER_ROLE");

    uint256 public maxOrdersPerBlock;
    uint256 public maxUnmatchedOrders;

    string internal constant FEE_CONTEXT_FUTURES = "Futures Trade";

    // -------- Errors --------
    error NotRegisteredAccount();
    error ZeroAddress();

    error InvalidMarket();
    error UnknownMarket();
    error InvalidReferencePrice();
    error InvalidOrder();
    error ExpiryInPast();
    error TooManyOrdersThisBlock();
    error TooManyOpenOrders();
    error MarketIsClosed();

    error InvalidDuration();
    error NoPassivePool();
    error EmptySnapshot();
    error InvalidBid();
    error InvalidAsk();
    error InternalCross();
    error BidCrossesBook();
    error AskCrossesBook();
    error PassiveQuoteExceedsCapacity();

    error OrderNotFound();
    error NotOrderOwner();
    error OrderIsCancelled();
    error OrderNotInBook();

    error InvalidPrice();
    error SyntheticInvalidPrice();

    error SpentExceedsLocked();
    error InvalidOrderLimits();

    enum Side {
        Buy, // close shorts first, then open longs
        Sell // close longs first, then open shorts
    }

    struct Order {
        uint256 orderId;
        address user; // Account contract address
        bytes32 marketKey;
        Side side;
        uint256 amount; // remaining size
        uint256 initial; // original size
        uint256 price; // limit price (same price-domain used for variation calc)
        uint256 expiry;
        uint256 timestamp;
        // Base margin component locked at placement using lastSettlementPrice
        uint256 marginLocked;
        // Fixed "variation / pnl buffer" locked at placement using (limit price vs settlement) worst-case adverse
        uint256 pnlLocked;
        // Total eth-collateral locked for this order in the Vault (MUST be only what was newly locked at placement)
        uint256 collateralLocked;
        // "Spent" from collateralLocked (opening margin consumed + adverse variation actually paid)
        uint256 collateralSpent;
        // === Fee snapshot locked at placement (separate from quote collateral) ===
        address feeToken; // preference
        address fixedFeeToken;
        uint256 fixedFeeTotal;
        bool fixedFeeCharged;
        address pctFeeToken;
        uint256 pctFeeTotal;
        uint256 pctFeeCharged;
    }

    struct PassiveLevel {
        uint128 price;
        uint128 remainingSize;
    }

    struct PassiveSnapshot {
        uint64 validUntilBlock;
        bool exists;
        PassiveLevel bestBid;
        PassiveLevel bestAsk;
    }

    mapping(bytes32 => PassiveSnapshot) public passiveSnapshot;
    mapping(bytes32 => address) public passivePoolForMarket;

    /// @dev Optional synthetic maker used by SettlementManager for imbalance.
    struct SyntheticImbalance {
        bool active;
        Side makerSide; // maker's side (Buy or Sell)
        uint256 price; // execution price to use
        uint256 amount; // remaining size capacity
        uint256 updatedAt;
    }

    FuturesContract public immutable futures;
    SethxVault public immutable vault;
    FeeManager public immutable feeManager;
    AccountRegistry public immutable accountRegistry;

    uint256 public nextOrderId = 1;

    // Buy book sorted high->low (bids)
    mapping(bytes32 => uint256[]) public buyBook;
    // Sell book sorted low->high (asks)
    mapping(bytes32 => uint256[]) public sellBook;

    mapping(uint256 => Order) public ordersById;
    mapping(address => uint256[]) public userOrders;
    mapping(uint256 => bool) public isOrderCancelled;

    mapping(bytes32 => SyntheticImbalance) public synthetic;

    mapping(address => mapping(bytes32 => uint256)) public lastOrderBlock;
    mapping(address => mapping(bytes32 => uint256)) public ordersInBlock;
    mapping(address => mapping(bytes32 => uint256)) public unmatchedOrderCount;

    event PassivePoolSet(bytes32 indexed marketKey, address indexed pool);
    event PassiveSnapshotPublished(
        bytes32 indexed marketKey,
        uint128 bidPrice,
        uint128 bidSize,
        uint128 askPrice,
        uint128 askSize,
        uint64 validUntilBlock
    );
    event PassiveSnapshotCleared(bytes32 indexed marketKey);

    event OrderMatchedWithPassive(
        uint256 indexed takerOrderId,
        bytes32 indexed marketKey,
        address indexed passivePool,
        uint256 amount,
        uint256 execPrice,
        Side passiveMakerSide,
        uint256 feeChargedThisStep
    );

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed marketKey,
        Side side,
        uint256 amount,
        uint256 price,
        uint256 expiry,
        address feeToken
    );

    event OrderMatched(
        uint256 indexed takerOrderId,
        uint256 indexed makerOrderId,
        uint256 amount,
        uint256 execPrice,
        uint256 feeChargedThisStep
    );

    event OrderMatchedWithSynthetic(
        uint256 indexed takerOrderId,
        bytes32 indexed marketKey,
        uint256 amount,
        uint256 execPrice,
        Side syntheticMakerSide,
        uint256 feeChargedThisStep
    );

    event OrderCancelled(uint256 indexed orderId);
    event OrderExpiredCancelled(uint256 indexed orderId);

    event SyntheticReplaced(
        bytes32 indexed marketKey,
        bool active,
        Side makerSide,
        uint256 amount,
        uint256 price
    );
    event SyntheticConsumed(bytes32 indexed marketKey, uint256 filled, uint256 remaining);
    event OrderLimitsSet(uint256 maxOrdersPerBlock, uint256 maxUnmatchedOrders);

    modifier onlyAccount() {
        if (!accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender))
            revert NotRegisteredAccount();
        _;
    }

    constructor(
        address _vault,
        address _accountRegistry,
        address _futuresContract,
        address _feeManager,
        address admin
    ) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_futuresContract == address(0)) revert ZeroAddress();
        if (_feeManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        futures = FuturesContract(_futuresContract);
        feeManager = FeeManager(_feeManager);

        maxOrdersPerBlock = 20;
        maxUnmatchedOrders = 100;

        emit OrderLimitsSet(20, 100);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // =========================================================
    // Admin
    // =========================================================

    function setSettlementManager(address sm) external onlyRole(ADMIN_ROLE) {
        if (sm == address(0)) revert ZeroAddress();
        _grantRole(SETTLEMENT_MANAGER_ROLE, sm);
    }

    function setPassivePublisher(address publisher, bool enabled) external onlyRole(ADMIN_ROLE) {
        if (publisher == address(0)) revert ZeroAddress();
        if (enabled) _grantRole(PASSIVE_MM_PUBLISHER_ROLE, publisher);
        else _revokeRole(PASSIVE_MM_PUBLISHER_ROLE, publisher);
    }

    function setPassivePool(bytes32 marketKey, address pool) external onlyRole(ADMIN_ROLE) {
        if (marketKey == bytes32(0)) revert InvalidMarket();
        if (pool == address(0)) revert ZeroAddress();
        if (!accountRegistry.isAccount(pool)) revert NotRegisteredAccount();
        passivePoolForMarket[marketKey] = pool;
        emit PassivePoolSet(marketKey, pool);
    }

    function clearPassiveSnapshot(bytes32 marketKey) external onlyRole(ADMIN_ROLE) {
        delete passiveSnapshot[marketKey];
        emit PassiveSnapshotCleared(marketKey);
    }

    function setOrderLimits(
        uint256 newMaxOrdersPerBlock,
        uint256 newMaxUnmatchedOrders
    ) external onlyRole(ADMIN_ROLE) {
        if (newMaxOrdersPerBlock == 0 || newMaxUnmatchedOrders == 0) {
            revert InvalidOrderLimits();
        }

        maxOrdersPerBlock = newMaxOrdersPerBlock;
        maxUnmatchedOrders = newMaxUnmatchedOrders;

        emit OrderLimitsSet(newMaxOrdersPerBlock, newMaxUnmatchedOrders);
    }

    // =========================================================
    // Views
    // =========================================================

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getBook(bytes32 marketKey, bool wantBuyBook) external view returns (uint256[] memory) {
        return wantBuyBook ? buyBook[marketKey] : sellBook[marketKey];
    }

    /// @notice Returns the top of the real user book only (excludes synthetic / virtual MM liquidity).
    /// @dev bestBid comes from buyBook sorted high->low; bestAsk comes from sellBook sorted low->high.
    ///      Cancelled / deleted / zero-sized orders are skipped.
    function getUserTopOfBook(
        bytes32 marketKey
    )
        external
        view
        returns (
            uint256 bestBidPrice,
            uint256 bestBidSize,
            uint256 bestAskPrice,
            uint256 bestAskSize
        )
    {
        return _getUserTopOfBook(marketKey);
    }

    function _getUserTopOfBook(
        bytes32 marketKey
    )
        internal
        view
        returns (
            uint256 bestBidPrice,
            uint256 bestBidSize,
            uint256 bestAskPrice,
            uint256 bestAskSize
        )
    {
        uint256[] storage bids = buyBook[marketKey];
        for (uint256 i = 0; i < bids.length; i++) {
            Order storage o = ordersById[bids[i]];
            if (o.orderId != 0 && !isOrderCancelled[bids[i]] && o.amount > 0) {
                bestBidPrice = o.price;
                bestBidSize = o.amount;
                break;
            }
        }

        uint256[] storage asks = sellBook[marketKey];
        for (uint256 i = 0; i < asks.length; i++) {
            Order storage o = ordersById[asks[i]];
            if (o.orderId != 0 && !isOrderCancelled[asks[i]] && o.amount > 0) {
                bestAskPrice = o.price;
                bestAskSize = o.amount;
                break;
            }
        }
    }

    /// @notice Aggregate visible depth from the real user books only within +/- `bps` of `referencePrice`.
    /// @dev Returns ETH size on each side. Synthetic / virtual MM liquidity is excluded.
    ///      Bid depth includes orders with price >= referencePrice * (1 - bps).
    ///      Ask depth includes orders with price <= referencePrice * (1 + bps).
    function getUserDepthWithinBps(
        bytes32 marketKey,
        uint256 referencePrice,
        uint16 bps
    ) external view returns (uint256 bidDepth, uint256 askDepth) {
        if (referencePrice == 0) revert InvalidReferencePrice();

        uint256 lowerBound = (referencePrice * (10_000 - bps)) / 10_000;
        uint256 upperBound = (referencePrice * (10_000 + bps)) / 10_000;

        uint256[] storage bids = buyBook[marketKey];
        for (uint256 i = 0; i < bids.length; i++) {
            uint256 orderId = bids[i];
            Order storage o = ordersById[orderId];

            if (o.orderId == 0 || isOrderCancelled[orderId] || o.amount == 0) {
                continue;
            }

            // buyBook is sorted high -> low, so once below lowerBound we can stop.
            if (o.price < lowerBound) {
                break;
            }

            bidDepth += o.amount;
        }

        uint256[] storage asks = sellBook[marketKey];
        for (uint256 i = 0; i < asks.length; i++) {
            uint256 orderId = asks[i];
            Order storage o = ordersById[orderId];

            if (o.orderId == 0 || isOrderCancelled[orderId] || o.amount == 0) {
                continue;
            }

            // sellBook is sorted low -> high, so once above upperBound we can stop.
            if (o.price > upperBound) {
                break;
            }

            askDepth += o.amount;
        }
    }

    // =========================================================
    // Placement
    // =========================================================

    function placeOrder(
        bytes32 marketKey,
        Side side,
        uint256 price,
        uint256 amount,
        uint256 expiry,
        address feeToken
    ) external onlyAccount {
        if (price == 0 || amount == 0) revert InvalidOrder();

        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);
        if (m.oracle == address(0)) revert UnknownMarket();

        if (expiry == 0) {
            expiry = block.timestamp + 30 days;
        } else {
            if (expiry <= block.timestamp) revert ExpiryInPast();
        }

        // per-block limit
        if (block.number != lastOrderBlock[msg.sender][marketKey]) {
            ordersInBlock[msg.sender][marketKey] = 0;
            lastOrderBlock[msg.sender][marketKey] = block.number;
        }
        if (ordersInBlock[msg.sender][marketKey] >= maxOrdersPerBlock) {
            revert TooManyOrdersThisBlock();
        }
        ordersInBlock[msg.sender][marketKey]++;

        if (unmatchedOrderCount[msg.sender][marketKey] >= maxUnmatchedOrders) {
            revert TooManyOpenOrders();
        }

        // =========================================================
        // 1) EXPECTED CLOSE-AWARE NET MARGIN LOCK AT PLACEMENT
        // =========================================================
        // BUY closes SHORT first => isLongPositionToClose = false
        // SELL closes LONG first => isLongPositionToClose = true
        bool isLongPositionToClose = (side == Side.Sell);

        FuturesContract.Position memory p = futures.getPosition(
            msg.sender,
            marketKey,
            isLongPositionToClose
        );

        uint256 expectedCloseAmt = 0;
        if (p.isActive && p.size > 0) {
            expectedCloseAmt = (p.size < amount) ? p.size : amount;
        }

        uint256 expectedOpenAmt = amount - expectedCloseAmt;

        // Closed markets must still permit reduce/close orders, but must not accept
        // any order that can create new exposure, even if it would initially rest.
        if (expectedOpenAmt > 0) {
            if (!futures.marketActive(marketKey)) revert MarketIsClosed();
        }

        // Base opening margin lock uses settlement reference, ONLY for expected OPEN portion.
        uint256 marginRequired = 0;
        if (expectedOpenAmt > 0) {
            marginRequired = _initialMarginRequired(
                marketKey,
                expectedOpenAmt,
                m.lastSettlementPrice
            );
        }

        // Fixed pnl buffer uses worst-case adverse between limit and settlement (does NOT change while resting)
        // NOTE: still based on FULL order amount (conservative ok).
        uint256 pnlBuffer = _pnlBufferWorstCaseAdverse(
            marketKey,
            side,
            amount,
            price,
            m.lastSettlementPrice
        );

        // Total order eth collateral pot (NEW lock) is only what we need additionally.
        uint256 collateral = marginRequired + pnlBuffer;

        // lock total collateral in eth
        _lockTokenOrETH(msg.sender, address(0), collateral);

        // =========================================================
        // 2) LOCK FEE SNAPSHOT (SEPARATE) BASED ON FUTURE NOTIONAL
        // =========================================================
        uint256 feeBase = _notionalFromPrice(marketKey, amount, price);
        (uint256 fixedAmt, address fixedTok, uint256 pctAmt, address pctTok) = _getFeesForBase(
            feeToken,
            address(0),
            feeBase,
            msg.sender,
            false
        );

        if (fixedAmt > 0) _lockTokenOrETH(msg.sender, fixedTok, fixedAmt);
        if (pctAmt > 0) _lockTokenOrETH(msg.sender, pctTok, pctAmt);

        // =========================================================
        // 3) STORE ORDER
        // =========================================================
        uint256 orderId = nextOrderId++;
        Order storage o = ordersById[orderId];

        o.orderId = orderId;
        o.user = msg.sender;
        o.marketKey = marketKey;
        o.side = side;

        o.amount = amount;
        o.initial = amount;
        o.price = price;
        o.expiry = expiry;
        o.timestamp = block.timestamp;

        o.marginLocked = marginRequired;
        o.pnlLocked = pnlBuffer;

        // IMPORTANT: collateralLocked must equal ONLY the newly locked collateral for this order.
        o.collateralLocked = collateral;
        o.collateralSpent = 0;

        o.feeToken = feeToken;

        o.fixedFeeToken = fixedTok;
        o.fixedFeeTotal = fixedAmt;
        o.fixedFeeCharged = false;

        o.pctFeeToken = pctTok;
        o.pctFeeTotal = pctAmt;
        o.pctFeeCharged = 0;

        userOrders[msg.sender].push(orderId);

        emit OrderPlaced(orderId, msg.sender, marketKey, side, amount, price, expiry, feeToken);

        // match now
        _match(orderId, m);

        // insert if remainder
        if (ordersById[orderId].orderId != 0 && ordersById[orderId].amount > 0) {
            if (ordersById[orderId].amount == amount) {
                _resnapshotUnfilledOrderFeesAsMaker(ordersById[orderId]);
            }
            if (side == Side.Buy) _insertSorted(buyBook[marketKey], orderId, true);
            else _insertSorted(sellBook[marketKey], orderId, false);

            unmatchedOrderCount[msg.sender][marketKey]++;
        } else {
            _finalizeFilled(orderId);
        }
    }

    function publishPassiveSnapshot(
        bytes32 marketKey,
        uint128 bidPrice,
        uint128 bidSize,
        uint128 askPrice,
        uint128 askSize,
        uint64 validForBlocks
    ) external onlyRole(PASSIVE_MM_PUBLISHER_ROLE) {
        if (validForBlocks == 0) revert InvalidDuration();
        if (passivePoolForMarket[marketKey] == address(0)) revert NoPassivePool();
        if (bidSize == 0 && askSize == 0) revert EmptySnapshot();
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);
        if (m.oracle == address(0)) revert UnknownMarket();

        // allow one-sided snapshots if needed, but if both sides exist they must not internally cross
        if (bidSize > 0 && bidPrice == 0) revert InvalidBid();
        if (askSize > 0 && askPrice == 0) revert InvalidAsk();
        if (bidSize > 0 && askSize > 0 && bidPrice >= askPrice) revert InternalCross();

        // real user book only
        (uint256 bestBid, , uint256 bestAsk, ) = _getUserTopOfBook(marketKey);

        // no crossing existing book, and no book fill at publish time
        if (bidSize > 0 && bestAsk != 0) {
            if (bidPrice >= bestAsk) revert BidCrossesBook();
        }
        if (askSize > 0 && bestBid != 0) {
            if (askPrice <= bestBid) revert AskCrossesBook();
        }

        address pool = passivePoolForMarket[marketKey];

        uint256 capacityNeed = 0;

        if (bidSize > 0) {
            capacityNeed += _passiveMakerFillNeed(
                pool,
                marketKey,
                Side.Buy,
                uint256(bidSize),
                uint256(bidPrice),
                m
            );
        }

        if (askSize > 0) {
            capacityNeed += _passiveMakerFillNeed(
                pool,
                marketKey,
                Side.Sell,
                uint256(askSize),
                uint256(askPrice),
                m
            );
        }

        if (capacityNeed > _freeETH(pool)) revert PassiveQuoteExceedsCapacity();

        uint64 validUntil = uint64(block.number + validForBlocks);

        passiveSnapshot[marketKey] = PassiveSnapshot({
            validUntilBlock: validUntil,
            exists: true,
            bestBid: PassiveLevel(bidPrice, bidSize),
            bestAsk: PassiveLevel(askPrice, askSize)
        });

        emit PassiveSnapshotPublished(marketKey, bidPrice, bidSize, askPrice, askSize, validUntil);
    }

    function _isPassiveActive(bytes32 marketKey) internal view returns (bool) {
        PassiveSnapshot storage s = passiveSnapshot[marketKey];
        return s.exists && block.number <= s.validUntilBlock;
    }

    // =========================================================
    // Cancel
    // =========================================================

    function cancelOrder(uint256 orderId) external onlyAccount {
        Order storage o = ordersById[orderId];
        if (o.orderId == 0) revert OrderNotFound();
        if (o.user != msg.sender) revert NotOrderOwner();
        if (isOrderCancelled[orderId]) revert OrderIsCancelled();

        bytes32 marketKey = o.marketKey;

        uint256[] storage book = (o.side == Side.Buy) ? buyBook[marketKey] : sellBook[marketKey];
        if (!_removeOrderIdFromBook(book, orderId)) revert OrderNotInBook();

        _unlockOnCancel(o);

        isOrderCancelled[orderId] = true;
        delete ordersById[orderId];

        if (unmatchedOrderCount[msg.sender][marketKey] > 0) {
            unmatchedOrderCount[msg.sender][marketKey]--;
        }

        emit OrderCancelled(orderId);
    }

    // =========================================================
    // Synthetic (optional)
    // =========================================================

    function replaceSyntheticImbalanceOrder(
        bytes32 marketKey,
        bool active,
        Side makerSide,
        uint256 amount,
        uint256 execPrice
    ) external onlyRole(SETTLEMENT_MANAGER_ROLE) {
        if (!active || amount == 0) {
            synthetic[marketKey] = SyntheticImbalance({
                active: false,
                makerSide: Side.Buy,
                price: 0,
                amount: 0,
                updatedAt: block.timestamp
            });
            emit SyntheticReplaced(marketKey, false, Side.Buy, 0, 0);
            return;
        }

        if (execPrice == 0) revert InvalidPrice();

        synthetic[marketKey] = SyntheticImbalance({
            active: true,
            makerSide: makerSide,
            price: execPrice,
            amount: amount,
            updatedAt: block.timestamp
        });

        emit SyntheticReplaced(marketKey, true, makerSide, amount, execPrice);
    }

    // =========================================================
    // Matching
    // =========================================================

    function _match(uint256 takerOrderId, FuturesContract.MarketConfig memory m) internal {
        Order storage taker = ordersById[takerOrderId];
        if (taker.orderId == 0 || taker.amount == 0) return;
        if (block.timestamp > taker.expiry) return;

        uint256[] storage oppBook =
            (taker.side == Side.Buy) ? sellBook[taker.marketKey] : buyBook[taker.marketKey];

        for (uint256 i = 0; i < oppBook.length && taker.amount > 0; ) {
            uint256 makerId = oppBook[i];
            Order storage maker = ordersById[makerId];

            if (maker.orderId == 0 || isOrderCancelled[makerId]) {
                _removeIdAt(oppBook, i);
                continue;
            }

            if (block.timestamp > maker.expiry) {
                _expireCancelMaker(oppBook, i, makerId);
                continue;
            }

            // price cross
            bool crossOk;
            uint256 execPrice;
            if (taker.side == Side.Buy) {
                crossOk = taker.price >= maker.price;
                execPrice = maker.price;
            } else {
                crossOk = maker.price >= taker.price;
                execPrice = maker.price;
            }
            if (!crossOk) break;

            uint256 tradeAmt = taker.amount < maker.amount ? taker.amount : maker.amount;
            if (tradeAmt == 0) break;

            // ---------------------------------------------------------------------
            // 1) SAFETY: close-aware affordability (NO "pre-credit" of close margin!)
            // ---------------------------------------------------------------------
            if (!_canAffordFill(maker, tradeAmt, execPrice, m)) {
                _cancelRestingMakerUnsafe(oppBook, i, makerId);
                continue;
            }
            if (!_canAffordFill(taker, tradeAmt, execPrice, m)) {
                _cancelTakerUnsafe(takerOrderId);
                return;
            }

            // ---------------------------------------------------------------------
            // 2) Settle variation (execPrice vs current settlement)
            // ---------------------------------------------------------------------
            _settleVariationBetween(taker, maker, tradeAmt, execPrice, m);

            // ---------------------------------------------------------------------
            // 3) Charge fees (separate locked fee budgets; fixed snapshot)
            // ---------------------------------------------------------------------
            uint256 takerFeeCharged = _chargeFeesForFillExact(taker, taker.user, tradeAmt);
            uint256 makerFeeCharged = _chargeFeesForFillExact(maker, maker.user, tradeAmt);

            // ---------------------------------------------------------------------
            // 4) Apply fills & consume opening margin from the order's locked pot
            // ---------------------------------------------------------------------
            _applyFillToUserAndConsumeMargin(taker, tradeAmt, m);
            _applyFillToUserAndConsumeMargin(maker, tradeAmt, m);

            taker.amount -= tradeAmt;
            maker.amount -= tradeAmt;

            emit OrderMatched(
                taker.orderId,
                maker.orderId,
                tradeAmt,
                execPrice,
                takerFeeCharged + makerFeeCharged
            );

            if (maker.amount == 0) {
                address makerUser = maker.user;
                bytes32 makerMarketKey = maker.marketKey;
                uint256 makerOrderId = maker.orderId;

                _finalizeFilled(makerOrderId);

                if (unmatchedOrderCount[makerUser][makerMarketKey] > 0) {
                    unmatchedOrderCount[makerUser][makerMarketKey]--;
                }

                _removeIdAt(oppBook, i);
            } else {
                i++;
            }
        }

        if (taker.amount > 0) {
            _matchAgainstPassive(takerOrderId, m);
        }

        if (taker.amount > 0) {
            _matchAgainstSynthetic(takerOrderId, m);
        }
    }

    /// Passive MM is treated as backstop liquidity:
    /// real user orders match first, then passive MM, then synthetic imbalance.
    function _matchAgainstPassive(
        uint256 takerOrderId,
        FuturesContract.MarketConfig memory m
    ) internal {
        Order storage taker = ordersById[takerOrderId];
        if (taker.orderId == 0 || taker.amount == 0) return;
        if (!_isPassiveActive(taker.marketKey)) return;

        address pool = passivePoolForMarket[taker.marketKey];
        if (pool == address(0)) return;

        PassiveSnapshot storage s = passiveSnapshot[taker.marketKey];

        bool takerIsBuy = (taker.side == Side.Buy);
        Side passiveMakerSide = takerIsBuy ? Side.Sell : Side.Buy;

        uint128 passivePrice;
        uint128 passiveSize;

        if (takerIsBuy) {
            passivePrice = s.bestAsk.price;
            passiveSize = s.bestAsk.remainingSize;

            if (passiveSize == 0 || passivePrice == 0) return;
            if (taker.price < passivePrice) return; // no cross
        } else {
            passivePrice = s.bestBid.price;
            passiveSize = s.bestBid.remainingSize;

            if (passiveSize == 0 || passivePrice == 0) return;
            if (passivePrice < taker.price) return; // no cross
        }

        uint256 tradeAmt = taker.amount < passiveSize ? taker.amount : passiveSize;
        if (tradeAmt == 0) return;

        uint256 execPrice = uint256(passivePrice);

        // taker still uses normal order-based affordability checks
        if (!_canAffordFill(taker, tradeAmt, execPrice, m)) {
            _cancelTakerUnsafe(takerOrderId);
            return;
        }

        // pool side uses free ETH + close-aware open margin
        if (
            !_canAffordPassiveMakerFill(
                pool,
                taker.marketKey,
                passiveMakerSide,
                tradeAmt,
                execPrice,
                m
            )
        ) {
            return;
        }

        // variation settlement between taker order and passive pool
        _settleVariationBetweenOrderAndAddress(taker, pool, tradeAmt, execPrice, m);

        uint256 feeCharged = _chargeFeesForFillExact(taker, taker.user, tradeAmt);

        // apply taker using existing order-collateral path
        _applyFillToUserAndConsumeMargin(taker, tradeAmt, m);

        // apply passive maker using direct account path
        _applyFillToUserDirectAndLockMargin(pool, taker.marketKey, passiveMakerSide, tradeAmt, m);

        taker.amount -= tradeAmt;

        if (takerIsBuy) {
            s.bestAsk.remainingSize -= uint128(tradeAmt);
        } else {
            s.bestBid.remainingSize -= uint128(tradeAmt);
        }

        emit OrderMatchedWithPassive(
            taker.orderId,
            taker.marketKey,
            pool,
            tradeAmt,
            execPrice,
            passiveMakerSide,
            feeCharged
        );

        // if snapshot is fully consumed, clear it
        if (s.bestBid.remainingSize == 0 && s.bestAsk.remainingSize == 0) {
            delete passiveSnapshot[taker.marketKey];
            emit PassiveSnapshotCleared(taker.marketKey);
        }
    }

    function _matchAgainstSynthetic(
        uint256 takerOrderId,
        FuturesContract.MarketConfig memory m
    ) internal {
        Order storage taker = ordersById[takerOrderId];
        if (taker.orderId == 0 || taker.amount == 0) return;

        SyntheticImbalance storage s = synthetic[taker.marketKey];
        if (!s.active || s.amount == 0) return;
        if (s.makerSide == taker.side) return;

        uint256 tradeAmt = taker.amount < s.amount ? taker.amount : s.amount;
        if (tradeAmt == 0) return;

        uint256 execPrice = s.price;
        if (execPrice == 0) revert SyntheticInvalidPrice();

        // If taker can't afford against settlement drift, cancel taker and stop.
        if (!_canAffordFillSynthetic(taker, tradeAmt, execPrice, m)) {
            _cancelTakerUnsafe(takerOrderId);
            return;
        }

        // NOTE: synthetic path currently does NOT settle variation transfers.

        // only user pays fees (synthetic pays none)
        uint256 feeCharged = _chargeFeesForFillExact(taker, taker.user, tradeAmt);

        _applyFillToUserAndConsumeMargin(taker, tradeAmt, m);

        taker.amount -= tradeAmt;
        s.amount -= tradeAmt;

        emit OrderMatchedWithSynthetic(
            taker.orderId,
            taker.marketKey,
            tradeAmt,
            execPrice,
            s.makerSide,
            feeCharged
        );
        emit SyntheticConsumed(taker.marketKey, tradeAmt, s.amount);

        if (s.amount == 0) s.active = false;
    }

    /// @dev Close opposite exposure first (always allowed), then open remainder if market active.
    /// Consumes the order's locked collateral pot ONLY for the opened remainder's margin.
    /// Returns amountOpened.
    function _applyFillToUserAndConsumeMargin(
        Order storage o,
        uint256 tradeAmt,
        FuturesContract.MarketConfig memory m
    ) internal returns (uint256 amountOpened) {
        bool wantLong = (o.side == Side.Buy);
        bool isLongToClose = !wantLong; // Buy closes shorts; Sell closes longs

        // 1) Close opposite if any (ledger reduced; vault stays locked)
        (uint256 closedAmt, ) = _closeOppositeIfAny(o.user, o.marketKey, isLongToClose, tradeAmt);

        uint256 remaining = tradeAmt - closedAmt;
        if (remaining == 0) return 0;

        if (!futures.marketActive(o.marketKey)) revert MarketIsClosed();

        // Opening margin uses CURRENT settlement reference
        uint256 marginReq = _initialMarginRequired(o.marketKey, remaining, m.lastSettlementPrice);

        _consumeLockedCollateral(o, marginReq);

        futures.openPosition(o.user, o.marketKey, remaining, marginReq, wantLong);
        return remaining;
    }

    /// @dev Close up to `maxClose` on an existing position (ledger only).
    /// Returns (closedSize, marginDebitedFromLedger).
    ///
    /// IMPORTANT:
    /// - Do NOT unlock in the vault here. Vault is a single locked pool.
    /// - We only reduce ledger margin; custody remains locked and is managed by SettlementManager / user actions.
    function _closeOppositeIfAny(
        address user,
        bytes32 marketKey,
        bool isLongPositionToClose,
        uint256 maxClose
    ) internal returns (uint256 closeAmt, uint256 closeMargin) {
        FuturesContract.Position memory p = futures.getPosition(
            user,
            marketKey,
            isLongPositionToClose
        );
        if (!p.isActive || p.size == 0 || maxClose == 0) return (0, 0);

        closeAmt = (p.size < maxClose) ? p.size : maxClose;
        closeMargin = (p.margin * closeAmt) / p.size;

        if (closeMargin > 0) {
            futures.adjustMargin(user, marketKey, isLongPositionToClose, -int256(closeMargin));
            _unlockTokenOrETH(user, address(0), closeMargin);
        }
        futures.reducePosition(user, marketKey, closeAmt, isLongPositionToClose);
    }

    function _expireCancelMaker(uint256[] storage book, uint256 index, uint256 makerId) internal {
        Order storage maker = ordersById[makerId];

        address makerUser = maker.user;
        bytes32 makerMarketKey = maker.marketKey;

        _unlockOnCancel(maker);

        isOrderCancelled[makerId] = true;
        delete ordersById[makerId];

        if (unmatchedOrderCount[makerUser][makerMarketKey] > 0) {
            unmatchedOrderCount[makerUser][makerMarketKey]--;
        }

        _removeIdAt(book, index);

        emit OrderExpiredCancelled(makerId);
    }

    // =========================================================
    // Close-aware affordability (VIEW ONLY)
    // =========================================================

    /// @dev Close-aware check:
    /// availableLocked >= adverseVariation(tradeAmt) + openMargin(openAmt)
    /// where openAmt = tradeAmt - closedAmt(view)
    function _canAffordFill(
        Order storage o,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal view returns (bool) {
        if (o.orderId == 0 || o.amount == 0) return false;
        if (tradeAmt == 0) return true;

        // close-aware open amount (view)
        (uint256 closeAmt, ) = _closeView(o, tradeAmt);
        uint256 openAmt = tradeAmt - closeAmt;

        uint256 adverseVariation = _adverseVariationForOrder(o, tradeAmt, execPrice, m);

        uint256 openMarginReq = 0;
        if (openAmt > 0) {
            openMarginReq = _initialMarginRequired(o.marketKey, openAmt, m.lastSettlementPrice);
        }

        uint256 need = adverseVariation + openMarginReq;

        uint256 available =
            (o.collateralLocked > o.collateralSpent) ? (o.collateralLocked - o.collateralSpent) : 0;

        return available >= need;
    }

    /// @dev Synthetic match affordability:
    /// - In current synthetic path we do not settle variation,
    ///   so require opening margin for the OPEN portion only.
    function _canAffordFillSynthetic(
        Order storage o,
        uint256 tradeAmt,
        uint256 /*execPrice*/,
        FuturesContract.MarketConfig memory m
    ) internal view returns (bool) {
        if (o.orderId == 0 || o.amount == 0) return false;
        if (tradeAmt == 0) return true;

        (uint256 closeAmt, ) = _closeView(o, tradeAmt);
        uint256 openAmt = tradeAmt - closeAmt;

        uint256 openMarginReq = 0;
        if (openAmt > 0) {
            openMarginReq = _initialMarginRequired(o.marketKey, openAmt, m.lastSettlementPrice);
        }

        uint256 available =
            (o.collateralLocked > o.collateralSpent) ? (o.collateralLocked - o.collateralSpent) : 0;

        return available >= openMarginReq;
    }

    function _adverseVariationForOrder(
        Order storage o,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal view returns (uint256) {
        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );
        uint256 execNorm = _normalizePrice(execPrice, m.oraclePriceDecimals, m.marginDecimals);

        if (execNorm == settleNorm) return 0;

        // If exec > settlement: BUY side pays; if exec < settlement: SELL side pays
        bool buyPays = execNorm > settleNorm;

        bool thisOrderPays = buyPays ? (o.side == Side.Buy) : (o.side == Side.Sell);
        if (!thisOrderPays) return 0;

        uint256 diff = execNorm > settleNorm ? (execNorm - settleNorm) : (settleNorm - execNorm);
        uint256 denom = 10 ** uint256(m.marginDecimals);
        return (diff * tradeAmt * m.multiplier) / denom;
    }

    function _canAffordPassiveMakerFill(
        address makerUser,
        bytes32 marketKey,
        Side makerSide,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal view returns (bool) {
        uint256 need = _passiveMakerFillNeed(
            makerUser,
            marketKey,
            makerSide,
            tradeAmt,
            execPrice,
            m
        );

        return _freeETH(makerUser) >= need;
    }

    function _passiveMakerFillNeed(
        address makerUser,
        bytes32 marketKey,
        Side makerSide,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal view returns (uint256) {
        if (tradeAmt == 0) return 0;

        (uint256 closeAmt, ) = _closeViewForAccount(makerUser, marketKey, makerSide, tradeAmt);

        uint256 openAmt = tradeAmt - closeAmt;

        uint256 adverseVariation = _adverseVariationForAccount(makerSide, tradeAmt, execPrice, m);

        uint256 openMarginReq = 0;

        if (openAmt > 0) {
            openMarginReq = _initialMarginRequired(marketKey, openAmt, m.lastSettlementPrice);
        }

        return adverseVariation + openMarginReq;
    }

    function _adverseVariationForAccount(
        Side side,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal pure returns (uint256) {
        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );
        uint256 execNorm = _normalizePrice(execPrice, m.oraclePriceDecimals, m.marginDecimals);

        if (execNorm == settleNorm) return 0;

        // If exec > settlement: BUY side pays; if exec < settlement: SELL side pays
        bool buyPays = execNorm > settleNorm;
        bool thisSidePays = buyPays ? (side == Side.Buy) : (side == Side.Sell);
        if (!thisSidePays) return 0;

        uint256 diff = execNorm > settleNorm ? (execNorm - settleNorm) : (settleNorm - execNorm);
        uint256 denom = 10 ** uint256(m.marginDecimals);
        return (diff * tradeAmt * m.multiplier) / denom;
    }

    function _settleVariationBetweenOrderAndAddress(
        Order storage taker,
        address passiveUser,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal {
        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );
        uint256 execNorm = _normalizePrice(execPrice, m.oraclePriceDecimals, m.marginDecimals);
        if (execNorm == settleNorm) return;

        bool buyPays = execNorm > settleNorm;
        uint256 diff = execNorm > settleNorm ? (execNorm - settleNorm) : (settleNorm - execNorm);
        uint256 denom = 10 ** uint256(m.marginDecimals);
        uint256 variation = (diff * tradeAmt * m.multiplier) / denom;
        if (variation == 0) return;

        if (buyPays) {
            if (taker.side == Side.Buy) {
                _consumeLockedCollateral(taker, variation);
                _transferLockedOrETH(
                    taker.user,
                    passiveUser,
                    address(0),
                    variation,
                    "futures_pnl_transfer"
                );
            } else {
                vault.transferETH(passiveUser, taker.user, variation, "futures_pnl_transfer");
            }
        } else {
            if (taker.side == Side.Sell) {
                _consumeLockedCollateral(taker, variation);
                _transferLockedOrETH(
                    taker.user,
                    passiveUser,
                    address(0),
                    variation,
                    "futures_pnl_transfer"
                );
            } else {
                vault.transferETH(passiveUser, taker.user, variation, "futures_pnl_transfer");
            }
        }
    }

    function _applyFillToUserDirectAndLockMargin(
        address user,
        bytes32 marketKey,
        Side side,
        uint256 tradeAmt,
        FuturesContract.MarketConfig memory m
    ) internal returns (uint256 amountOpened) {
        bool wantLong = (side == Side.Buy);
        bool isLongToClose = !wantLong; // Buy closes shorts; Sell closes longs

        (uint256 closedAmt, ) = _closeOppositeIfAny(user, marketKey, isLongToClose, tradeAmt);

        uint256 remaining = tradeAmt - closedAmt;
        if (remaining == 0) return 0;

        if (!futures.marketActive(marketKey)) revert MarketIsClosed();

        uint256 marginReq = _initialMarginRequired(marketKey, remaining, m.lastSettlementPrice);

        // passive maker locks margin directly from free vault balance at fill time
        _lockTokenOrETH(user, address(0), marginReq);

        futures.openPosition(user, marketKey, remaining, marginReq, wantLong);
        return remaining;
    }
    function _settleVariationBetween(
        Order storage taker,
        Order storage maker,
        uint256 tradeAmt,
        uint256 execPrice,
        FuturesContract.MarketConfig memory m
    ) internal {
        uint256 settleNorm = _normalizePrice(
            m.lastSettlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );
        uint256 execNorm = _normalizePrice(execPrice, m.oraclePriceDecimals, m.marginDecimals);
        if (execNorm == settleNorm) return;

        bool buyPays = execNorm > settleNorm;
        uint256 diff = execNorm > settleNorm ? (execNorm - settleNorm) : (settleNorm - execNorm);
        uint256 denom = 10 ** uint256(m.marginDecimals);
        uint256 variation = (diff * tradeAmt * m.multiplier) / denom;
        if (variation == 0) return;

        // Identify buy-order and sell-order for this match
        Order storage buyOrder = (taker.side == Side.Buy) ? taker : maker;
        Order storage sellOrder = (taker.side == Side.Buy) ? maker : taker;

        if (buyPays) {
            _consumeLockedCollateral(buyOrder, variation);
            _transferLockedOrETH(
                buyOrder.user,
                sellOrder.user,
                address(0),
                variation,
                "futures_pnl_transfer"
            );
        } else {
            _consumeLockedCollateral(sellOrder, variation);
            _transferLockedOrETH(
                sellOrder.user,
                buyOrder.user,
                address(0),
                variation,
                "futures_pnl_transfer"
            );
        }
    }

    function _cancelRestingMakerUnsafe(
        uint256[] storage book,
        uint256 index,
        uint256 makerId
    ) internal {
        Order storage maker = ordersById[makerId];

        address makerUser = maker.user;
        bytes32 makerMarketKey = maker.marketKey;

        _unlockOnCancel(maker);

        isOrderCancelled[makerId] = true;
        delete ordersById[makerId];

        if (unmatchedOrderCount[makerUser][makerMarketKey] > 0) {
            unmatchedOrderCount[makerUser][makerMarketKey]--;
        }

        _removeIdAt(book, index);

        emit OrderCancelled(makerId);
    }

    function _cancelTakerUnsafe(uint256 takerId) internal {
        Order storage taker = ordersById[takerId];
        if (taker.orderId == 0) return;

        _unlockOnCancel(taker);
        isOrderCancelled[takerId] = true;
        delete ordersById[takerId];

        emit OrderCancelled(takerId);
    }

    function _closeView(
        Order storage o,
        uint256 tradeAmt
    ) internal view returns (uint256 closeAmt, uint256 closeMargin) {
        if (tradeAmt == 0) return (0, 0);

        // BUY closes shorts; SELL closes longs
        bool isLongPositionToClose = (o.side == Side.Sell);

        FuturesContract.Position memory p = futures.getPosition(
            o.user,
            o.marketKey,
            isLongPositionToClose
        );

        if (!p.isActive || p.size == 0) return (0, 0);

        closeAmt = p.size < tradeAmt ? p.size : tradeAmt;
        closeMargin = (p.margin * closeAmt) / p.size; // pro-rata margin release (ledger-only)
    }

    function _closeViewForAccount(
        address user,
        bytes32 marketKey,
        Side side,
        uint256 tradeAmt
    ) internal view returns (uint256 closeAmt, uint256 closeMargin) {
        if (tradeAmt == 0) return (0, 0);

        // BUY closes shorts; SELL closes longs
        bool isLongPositionToClose = (side == Side.Sell);

        FuturesContract.Position memory p = futures.getPosition(
            user,
            marketKey,
            isLongPositionToClose
        );

        if (!p.isActive || p.size == 0) return (0, 0);

        closeAmt = p.size < tradeAmt ? p.size : tradeAmt;
        closeMargin = (p.margin * closeAmt) / p.size;
    }

    // =========================================================
    // Fees (fixed snapshot; locked separately)
    // =========================================================

    function _getFeesForBase(
        address paymentToken,
        address quoteToken,
        uint256 feeBase,
        address account,
        bool isMaker
    )
        internal
        view
        returns (uint256 fixedAmt, address fixedToken, uint256 pctAmt, address pctToken)
    {
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            paymentToken,
            quoteToken,
            feeBase,
            FEE_CONTEXT_FUTURES,
            account,
            isMaker
        );
        return (f.fixedAmount, f.fixedToken, f.percentageAmount, f.percentageToken);
    }

    function _resnapshotUnfilledOrderFeesAsMaker(Order storage o) internal {
        if (o.orderId == 0 || o.amount == 0 || o.amount != o.initial) return;

        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        }
        if (o.pctFeeTotal > o.pctFeeCharged) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal - o.pctFeeCharged);
        }

        uint256 feeBase = _notionalFromPrice(o.marketKey, o.amount, o.price);
        (uint256 fixedAmt, address fixedTok, uint256 pctAmt, address pctTok) = _getFeesForBase(
            o.feeToken,
            address(0),
            feeBase,
            o.user,
            true
        );

        o.fixedFeeToken = fixedTok;
        o.fixedFeeTotal = fixedAmt;
        o.fixedFeeCharged = false;

        o.pctFeeToken = pctTok;
        o.pctFeeTotal = pctAmt;
        o.pctFeeCharged = 0;

        if (fixedAmt > 0) _lockTokenOrETH(o.user, fixedTok, fixedAmt);
        if (pctAmt > 0) _lockTokenOrETH(o.user, pctTok, pctAmt);
    }

    function _chargeFeesForFillExact(
        Order storage feeOrder,
        address feePayer,
        uint256 matchSize
    ) internal returns (uint256 chargedThisStep) {
        // fixed once per order
        if (!feeOrder.fixedFeeCharged) {
            if (feeOrder.fixedFeeTotal > 0) {
                vault.chargeFee(
                    feePayer,
                    feeOrder.fixedFeeToken,
                    feeOrder.fixedFeeTotal,
                    "futures_trade_fee_fixed",
                    true
                );
                chargedThisStep += feeOrder.fixedFeeTotal;
            }
            feeOrder.fixedFeeCharged = true;
        }

        // pct pro-rata by filled size
        if (feeOrder.pctFeeTotal == 0) return chargedThisStep;

        uint256 filledBefore = (feeOrder.initial - feeOrder.amount);
        uint256 filledAfter = filledBefore + matchSize;

        if (filledAfter >= feeOrder.initial) {
            uint256 remainder = feeOrder.pctFeeTotal - feeOrder.pctFeeCharged;
            if (remainder > 0) {
                vault.chargeFee(
                    feePayer,
                    feeOrder.pctFeeToken,
                    remainder,
                    "futures_trade_fee_pct",
                    false
                );
                feeOrder.pctFeeCharged = feeOrder.pctFeeTotal;
                chargedThisStep += remainder;
            }
            return chargedThisStep;
        }

        uint256 pctTargetAfter = (feeOrder.pctFeeTotal * filledAfter) / feeOrder.initial;
        if (pctTargetAfter > feeOrder.pctFeeCharged) {
            uint256 delta = pctTargetAfter - feeOrder.pctFeeCharged;
            vault.chargeFee(feePayer, feeOrder.pctFeeToken, delta, "futures_trade_fee_pct", false);
            feeOrder.pctFeeCharged = pctTargetAfter;
            chargedThisStep += delta;
        }

        return chargedThisStep;
    }

    // =========================================================
    // Collateral + Margin math
    // =========================================================

    function _consumeLockedCollateral(Order storage o, uint256 amt) internal {
        o.collateralSpent += amt;
        if (o.collateralSpent > o.collateralLocked) revert SpentExceedsLocked();
    }

    /// @dev notional = size * multiplier * priceNorm / 10^marginDec
    function _notionalFromPrice(
        bytes32 marketKey,
        uint256 size,
        uint256 rawPrice
    ) internal view returns (uint256) {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);
        uint256 priceNorm = _normalizePrice(rawPrice, m.oraclePriceDecimals, m.marginDecimals);
        uint256 denom = 10 ** uint256(m.marginDecimals);
        return (size * m.multiplier * priceNorm) / denom;
    }

    function _pnlBufferWorstCaseAdverse(
        bytes32 marketKey,
        Side side,
        uint256 size,
        uint256 limitPrice,
        uint256 settlementPrice
    ) internal view returns (uint256) {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);

        uint256 limitNorm = _normalizePrice(limitPrice, m.oraclePriceDecimals, m.marginDecimals);
        uint256 settleNorm = _normalizePrice(
            settlementPrice,
            m.oraclePriceDecimals,
            m.marginDecimals
        );

        uint256 diff;
        if (side == Side.Buy) {
            if (limitNorm <= settleNorm) return 0;
            diff = limitNorm - settleNorm;
        } else {
            if (settleNorm <= limitNorm) return 0;
            diff = settleNorm - limitNorm;
        }

        uint256 denom = 10 ** uint256(m.marginDecimals);
        return (diff * size * m.multiplier) / denom;
    }

    function _initialMarginRequired(
        bytes32 marketKey,
        uint256 size,
        uint256 rawPrice
    ) internal view returns (uint256) {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);

        uint256 priceNorm = _normalizePrice(rawPrice, m.oraclePriceDecimals, m.marginDecimals);

        uint256 denom = 10_000 * (10 ** uint256(m.marginDecimals));
        return (size * m.multiplier * priceNorm * m.initialMarginBps) / denom;
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
            return rawPrice / factor; // conservative floor
        }
    }

    // =========================================================
    // Unlock helpers (cancel / full fill)
    // =========================================================

    function _unlockOnCancel(Order storage o) internal {
        uint256 remainingCollateral =
            o.collateralLocked > o.collateralSpent ? (o.collateralLocked - o.collateralSpent) : 0;

        // unlock unused ETH collateral (ONLY what this order locked at placement)
        if (remainingCollateral > 0) _unlockTokenOrETH(o.user, address(0), remainingCollateral);

        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        }

        uint256 pctRemain = o.pctFeeTotal > o.pctFeeCharged ? (o.pctFeeTotal - o.pctFeeCharged) : 0;
        if (pctRemain > 0) _unlockTokenOrETH(o.user, o.pctFeeToken, pctRemain);
    }

    function _finalizeFilled(uint256 orderId) internal {
        Order storage o = ordersById[orderId];
        if (o.orderId == 0) return;

        uint256 remainingCollateral =
            o.collateralLocked > o.collateralSpent ? (o.collateralLocked - o.collateralSpent) : 0;

        // unlock unused ETH collateral (ONLY what this order locked at placement)
        if (remainingCollateral > 0) _unlockTokenOrETH(o.user, address(0), remainingCollateral);

        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
            o.fixedFeeCharged = true;
        }

        uint256 pctRemain = o.pctFeeTotal > o.pctFeeCharged ? (o.pctFeeTotal - o.pctFeeCharged) : 0;
        if (pctRemain > 0) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, pctRemain);
            o.pctFeeCharged = o.pctFeeTotal;
        }

        delete ordersById[orderId];
    }

    // =========================================================
    // Vault helpers
    // =========================================================

    function _lockTokenOrETH(address account, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) vault.lockETH(account, amount);
        else vault.lockERC20(account, token, amount);
    }

    function _unlockTokenOrETH(address account, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) vault.unlockETH(account, amount);
        else vault.unlockERC20(account, token, amount);
    }

    /// @dev Transfers value out of *locked* quote collateral from `from` to `to`.
    /// IMPORTANT: SethxVault MUST restrict transfer methods to ORDERBOOK_ROLE.
    function _transferLockedOrETH(
        address from,
        address to,
        address token,
        uint256 amount,
        string memory reason
    ) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            vault.transferETH(from, to, amount, reason);
        } else {
            vault.transferToken(from, to, token, amount, reason);
        }
    }

    function _freeETH(address user) internal view returns (uint256) {
        SethxVault.EthBalancesView memory b = vault.getEthBalances(user);
        return b.freeEth;
    }

    // =========================================================
    // Book ops
    // =========================================================

    function _insertSorted(uint256[] storage book, uint256 orderId, bool isBuyBook) internal {
        uint256 index = book.length;
        uint256 p = ordersById[orderId].price;

        for (uint256 i = 0; i < book.length; i++) {
            uint256 otherId = book[i];
            uint256 op = ordersById[otherId].price;

            bool before = isBuyBook ? (p > op) : (p < op);
            if (before) {
                index = i;
                break;
            }
        }

        book.push(orderId);
        for (uint256 j = book.length - 1; j > index; j--) {
            book[j] = book[j - 1];
        }
        book[index] = orderId;
    }

    function _removeOrderIdFromBook(
        uint256[] storage book,
        uint256 orderId
    ) internal returns (bool) {
        for (uint256 i = 0; i < book.length; i++) {
            if (book[i] == orderId) {
                _removeIdAt(book, i);
                return true;
            }
        }
        return false;
    }

    function _removeIdAt(uint256[] storage book, uint256 index) internal {
        uint256 len = book.length;
        if (index >= len) return;

        for (uint256 i = index; i + 1 < len; i++) {
            book[i] = book[i + 1];
        }
        book.pop();
    }
}
