// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { OptionContract } from "./OptionContract.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

/**
 * @notice Options orderbook (non-tokenized baseline)
 *
 * Fee rules (as requested):
 * - Only the PREMIUM PAYER pays fees. Stored long-side premium payer orders are BuyOption.
 * - Writer does NOT pay fees.
 * - Fixed fee is charged ONCE per premium-payer ORDER (stored limit order via placeOrder).
 * - Percentage fee is charged PRO-RATA to filled premium; exact equality on full fill.
 * - For acceptOrder() where the CALLER is premium payer (maker is short):
 *      - that "taker order" is not stored => we charge fixed once in that accept tx,
 *        and charge percentage for the accepted premium (single fill).
 *
 * IMPORTANT:
 * - We snapshot fees at placement for long-side stored orders.
 * - We track fee charging progress on the stored order:
 *      fixedFeeCharged (bool) and pctFeeCharged (uint256)
 * - Cancel/expiry unlock uses stored totals minus charged amounts (NO recalculation).
 */
contract OptionsOrderBook is AccessControl {
    error ZeroAddress();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidStrike();
    error InvalidExpiry();
    error InvalidPaymentToken();
    error InvalidOrderIntent();
    error OrderDoesNotExist();
    error OrderIsCancelled();
    error OrderExpired();
    error InsufficientMakerRemaining();
    error MarketKeyNotFound();
    error PremiumSpentExceedsLocked();
    error TooManyOpenOrders();
    error InvalidOrderLimits();
    error TooManyOrdersThisBlock();
    error NotOrderOwner();
    error AlreadyCancelled();
    error AlreadyFilled();
    error OrderNotInBook();
    error UnsupportedMakerIntent();
    error UnsupportedPairing();

    enum OrderIntent {
        BuyOption, // long-side (premium payer)
        SellOption, // short-side secondary holder transfer
        WriteOption, // short-side open (writer)
        SellWriter // short-side sell/transfer an existing writer position
    }

    struct Order {
        uint256 orderId;
        address user; // account contract address
        // Market params
        OptionContract.OptionType optionType;
        address assetToken;
        address paymentToken;
        uint256 strikePrice;
        uint256 optionExpiry;
        // Preferred fee payment token for premium payer (long-side)
        address feeToken;
        OrderIntent intent;
        uint256 size;
        uint256 filled;
        uint256 askPrice; // premium per unit (in paymentToken, WAD)
        uint256 expiry; // order expiry (NOT option expiry)
        uint256 timestamp;
        // Fee snapshot for LONG-SIDE stored orders only
        address fixedFeeToken;
        uint256 fixedFeeTotal; // charged once per order (0 or >0)
        bool fixedFeeCharged;
        address pctFeeToken; // feeToken or paymentToken
        uint256 pctFeeTotal; // total pct fee for full premium budget
        uint256 pctFeeCharged; // cumulative charged so far (<= pctFeeTotal)
        // ---- Premium budget tracking (LONG-side stored orders only) ----
        uint256 premiumLocked; // snapshot of locked premium budget = floor(size*askPrice/WAD)
        uint256 premiumSpent; // cumulative grossPremium transferred so far
    }

    // ----- Rate limits -----
    uint256 public maxOrdersPerBlock;
    uint256 public maxUnmatchedOrders;
    mapping(address => mapping(bytes32 => uint256)) public lastOrderBlock;
    mapping(address => mapping(bytes32 => uint256)) public ordersInBlock;
    mapping(address => mapping(bytes32 => uint256)) public unmatchedOrderCount;
    mapping(uint256 => bool) public isOrderInBook;

    // ----- Storage -----
    uint256 public nextOrderId = 1;

    mapping(bytes32 => uint256[]) public longSideBook; // bids (BuyOption)
    mapping(bytes32 => uint256[]) public shortSideBook; // asks (WriteOption, SellOption, SellWriter)

    mapping(uint256 => bytes32) public orderMarketKey;
    mapping(uint256 => bool) public isOrderCancelled;
    mapping(uint256 => Order) public ordersById;
    mapping(address => uint256[]) private userOrders;

    // ---- Active markets tracking ----
    bytes32[] public activeMarkets;
    mapping(bytes32 => uint256) public activeMarketIndexPlus1; // 1-based index in activeMarkets
    mapping(bytes32 => uint256) public openOrderCountByMarket; // total open resting orders across both books

    struct MarketMeta {
        OptionContract.OptionType t;
        address asset;
        address paymentToken;
        uint256 strike;
        uint256 expiry;
    }
    mapping(bytes32 => MarketMeta) public marketMeta;
    mapping(bytes32 => bool) public marketMetaSet;

    // ----- External contracts -----
    SethxVault public immutable vault;
    OptionContract public immutable optionContract;
    FeeManager public immutable feeManager;
    AccountRegistry public immutable accountRegistry;

    // ----- Fee context -----
    string internal constant FEE_CONTEXT_OPTIONS = "Options Trade";

    // ----- Events -----
    event OrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed marketKey,
        OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        address feeToken
    );

    event OrderMatched(
        uint256 indexed takerOrderId, // 0 for acceptOrder (no stored taker order)
        uint256 indexed makerOrderId,
        uint256 size,
        uint256 grossPremium,
        uint256 totalFeeCharged, // fee charged in this match step
        uint256 premiumPaidToCounterparty
    );

    event OrderCancelled(uint256 indexed orderId);
    event OrderExpiredCancelled(uint256 indexed orderId);
    event RateLimitHit(address indexed user, bytes32 indexed marketKey, uint256 blockNumber);

    event OrderLimitsSet(uint256 maxOrdersPerBlock, uint256 maxUnmatchedOrders);

    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }

        _;
    }

    uint256 private constant WAD = 1e18;

    constructor(
        address _vault,
        address _accountRegistry,
        address _optionContract,
        address _feeManager,
        address admin
    ) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_optionContract == address(0)) revert ZeroAddress();
        if (_feeManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        optionContract = OptionContract(_optionContract);
        feeManager = FeeManager(_feeManager);

        maxOrdersPerBlock = 20;
        maxUnmatchedOrders = 100;

        emit OrderLimitsSet(20, 100);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setOrderLimits(
        uint256 newMaxOrdersPerBlock,
        uint256 newMaxUnmatchedOrders
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxOrdersPerBlock == 0 || newMaxUnmatchedOrders == 0) {
            revert InvalidOrderLimits();
        }

        maxOrdersPerBlock = newMaxOrdersPerBlock;
        maxUnmatchedOrders = newMaxUnmatchedOrders;

        emit OrderLimitsSet(newMaxOrdersPerBlock, newMaxUnmatchedOrders);
    }

    // ----- Views -----
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return ordersById[orderId];
    }

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getOpenOrders(
        bytes32 marketKey,
        bool isLongSide_
    ) external view returns (Order[] memory) {
        uint256[] storage ids = isLongSide_ ? longSideBook[marketKey] : shortSideBook[marketKey];
        Order[] memory out = new Order[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = ordersById[ids[i]];
        return out;
    }

    function getMarketTotals(
        bytes32 marketKey
    ) external view returns (uint256 bidRemaining, uint256 askRemaining) {
        uint256[] storage bidIds = longSideBook[marketKey];
        uint256[] storage askIds = shortSideBook[marketKey];

        for (uint256 i = 0; i < bidIds.length; i++) {
            Order storage o = ordersById[bidIds[i]];
            if (o.size > o.filled) bidRemaining += (o.size - o.filled);
        }
        for (uint256 i = 0; i < askIds.length; i++) {
            Order storage o = ordersById[askIds[i]];
            if (o.size > o.filled) askRemaining += (o.size - o.filled);
        }
    }

    // =========================================================
    //  Place (creates a stored order and auto-matches)
    // =========================================================
    function placeOrder(
        OptionContract.OptionType optionType,
        address assetToken,
        address paymentToken,
        uint256 strikePrice,
        uint256 optionExpiry,
        uint256 orderExpiry,
        address feeToken,
        OrderIntent intent,
        uint256 size,
        uint256 askPrice
    ) external onlyAccount {
        if (!_isValidIntent(intent)) revert InvalidOrderIntent();
        if (size == 0) revert InvalidAmount();
        if (askPrice == 0) revert InvalidPrice();
        if (orderExpiry <= block.timestamp) revert InvalidExpiry();
        if (optionExpiry <= block.timestamp) revert InvalidExpiry();
        if (orderExpiry > optionExpiry) revert InvalidExpiry();
        if (strikePrice == 0) revert InvalidStrike();
        if (paymentToken != address(0)) revert InvalidPaymentToken();

        // Enforce standardized weekly expiry (Friday 12:00 UTC)
        optionContract.requireValidExpiry(optionExpiry);

        // Normalize strike on-chain so orderbooks converge to the same market grid
        uint256 normalizedStrike = optionContract.normalizeStrike(strikePrice);

        bytes32 marketKey = optionContract.computeMarketKey(
            optionType,
            assetToken,
            paymentToken,
            normalizedStrike,
            optionExpiry
        );

        if (!marketMetaSet[marketKey]) {
            marketMetaSet[marketKey] = true;
            marketMeta[marketKey] = MarketMeta(
                optionType,
                assetToken,
                paymentToken,
                normalizedStrike,
                optionExpiry
            );
        }

        _checkAndRecordOrderLimit(msg.sender, marketKey);

        uint256 orderId = nextOrderId++;
        Order storage o = ordersById[orderId];

        o.orderId = orderId;
        o.user = msg.sender;

        o.optionType = optionType;
        o.assetToken = assetToken;
        o.paymentToken = paymentToken;
        o.strikePrice = normalizedStrike;
        o.optionExpiry = optionExpiry;

        o.feeToken = feeToken;

        o.intent = intent;
        o.size = size;
        o.filled = 0;
        o.askPrice = askPrice;
        o.expiry = orderExpiry;
        o.timestamp = block.timestamp;

        orderMarketKey[orderId] = marketKey;
        userOrders[msg.sender].push(orderId);

        _lockAndMaybeSnapshotFees(o, false);

        emit OrderPlaced(orderId, msg.sender, marketKey, intent, size, askPrice, feeToken);

        if (_isLongSide(intent)) {
            _matchAgainstBook(marketKey, orderId, shortSideBook[marketKey], true);

            if (
                ordersById[orderId].orderId != 0 &&
                ordersById[orderId].filled < ordersById[orderId].size
            ) {
                _resnapshotUnfilledBuyFeesAsMaker(ordersById[orderId]);
                _insertSorted(longSideBook[marketKey], orderId, true);
                _marketAddOpen(marketKey);
                _markOrderInBook(orderId);
            } else {
                _finalizeFilled(orderId);
            }
        } else {
            _matchAgainstBook(marketKey, orderId, longSideBook[marketKey], false);

            if (
                ordersById[orderId].orderId != 0 &&
                ordersById[orderId].filled < ordersById[orderId].size
            ) {
                _insertSorted(shortSideBook[marketKey], orderId, false);
                _marketAddOpen(marketKey);
                _markOrderInBook(orderId);
            } else {
                _finalizeFilled(orderId);
            }
        }
    }

    // =========================================================
    //  Accept (taker executes directly against a maker orderId)
    // =========================================================
    function acceptOrder(
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyAccount {
        if (amount == 0) revert InvalidAmount();

        Order storage maker = ordersById[makerOrderId];
        if (maker.orderId == 0) revert OrderDoesNotExist();
        if (isOrderCancelled[makerOrderId]) revert OrderIsCancelled();
        if (block.timestamp > maker.expiry) revert OrderExpired();

        uint256 makerRemaining = maker.size - maker.filled;
        if (makerRemaining < amount) revert InsufficientMakerRemaining();

        bytes32 marketKey = orderMarketKey[makerOrderId];
        if (marketKey == bytes32(0)) revert MarketKeyNotFound();

        bool makerIsLong = _isLongSide(maker.intent);

        address premiumPayer;
        address premiumReceiver;
        address payerFeeToken;

        if (maker.intent == OrderIntent.SellWriter) {
            // Existing writer/maker sells writer position.
            // New writer/taker pays premium to existing writer/maker.
            premiumPayer = msg.sender;
            premiumReceiver = maker.user;
            payerFeeToken = feeToken;
        } else {
            premiumPayer = makerIsLong ? maker.user : msg.sender;
            premiumReceiver = makerIsLong ? msg.sender : maker.user;
            payerFeeToken = makerIsLong ? maker.feeToken : feeToken;
        }

        _lockForAccept(maker, amount, payerFeeToken, makerIsLong);

        uint256 grossPremium = (amount * maker.askPrice) / WAD;

        // ✅ Track premium spent for long-side stored maker
        if (makerIsLong) {
            maker.premiumSpent += grossPremium;
            if (marketKey == bytes32(0)) revert MarketKeyNotFound();
        }

        _transferTokenOrETH(
            premiumPayer,
            premiumReceiver,
            maker.paymentToken,
            grossPremium,
            "option_premium"
        );

        uint256 feeChargedThisStep = 0;

        if (makerIsLong) {
            feeChargedThisStep = _chargeFeesForFillExact(maker, premiumPayer, amount);
        } else {
            (
                uint256 fixedAmt,
                address fixedTok,
                uint256 pctAmt,
                address pctTok
            ) = _getFeesForPremium(
                    payerFeeToken,
                    maker.paymentToken,
                    grossPremium,
                    premiumPayer,
                    false
                );

            if (fixedAmt > 0) {
                vault.chargeFee(premiumPayer, fixedTok, fixedAmt, "option_trade_fee_fixed", true);
                feeChargedThisStep += fixedAmt;
            }
            if (pctAmt > 0) {
                vault.chargeFee(premiumPayer, pctTok, pctAmt, "option_trade_fee_pct", false);
                feeChargedThisStep += pctAmt;
            }
        }

        // ---- Positions ----
        if (maker.intent == OrderIntent.WriteOption) {
            optionContract.registerNewOption(
                maker.optionType,
                maker.assetToken,
                maker.paymentToken,
                maker.strikePrice,
                maker.optionExpiry,
                maker.user,
                msg.sender,
                amount
            );
        } else if (maker.intent == OrderIntent.SellOption) {
            optionContract.releasePositionReservation(marketKey, maker.user, amount, false);
            optionContract.transferPosition(marketKey, maker.user, msg.sender, amount, false);
        } else if (maker.intent == OrderIntent.SellWriter) {
            optionContract.releasePositionReservation(marketKey, maker.user, amount, true);
            _transferWriterCollateral(maker, maker.user, msg.sender, amount);
            optionContract.transferPosition(marketKey, maker.user, msg.sender, amount, true);
        } else if (maker.intent == OrderIntent.BuyOption) {
            (, uint256 holderSize, uint256 holderExercised) = optionContract.getUserPosition(
                marketKey,
                msg.sender
            );
            uint256 holderAvail = holderSize > holderExercised ? (holderSize - holderExercised) : 0;

            if (holderAvail >= amount) {
                optionContract.transferPosition(marketKey, msg.sender, maker.user, amount, false);
            } else {
                optionContract.registerNewOption(
                    maker.optionType,
                    maker.assetToken,
                    maker.paymentToken,
                    maker.strikePrice,
                    maker.optionExpiry,
                    msg.sender,
                    maker.user,
                    amount
                );
            }
        } else {
            revert UnsupportedMakerIntent();
        }

        maker.filled += amount;

        emit OrderMatched(0, maker.orderId, amount, grossPremium, feeChargedThisStep, grossPremium);

        if (maker.filled == maker.size) {
            uint256[] storage book =
                makerIsLong ? longSideBook[marketKey] : shortSideBook[marketKey];

            _clearRestingOrderCount(makerOrderId);
            _removeOrderIdFromBook(book, makerOrderId);
            _marketRemoveOpen(marketKey);
            _finalizeFilled(makerOrderId);
        }
    }

    // =========================================================
    //  Cancel
    // =========================================================
    function cancelOrder(uint256 orderId) external onlyAccount {
        if (isOrderCancelled[orderId]) revert AlreadyCancelled();

        // IMPORTANT: use STORAGE (not memory) so fee progress is up-to-date.
        Order storage order = ordersById[orderId];
        if (order.orderId == 0) revert OrderDoesNotExist();
        if (order.user != msg.sender) revert NotOrderOwner();
        if (order.filled >= order.size) revert AlreadyFilled();

        bytes32 marketKey = orderMarketKey[orderId];

        uint256[] storage book =
            _isLongSide(order.intent) ? longSideBook[marketKey] : shortSideBook[marketKey];

        bool removed = _removeOrderIdFromBook(book, orderId);
        if (!removed) revert OrderNotInBook();
        _marketRemoveOpen(marketKey);

        uint256 remaining = order.size - order.filled;

        // Unlock using storage-backed fee state
        _unlockOnCancel(order, remaining);

        _clearRestingOrderCount(orderId);

        isOrderCancelled[orderId] = true;
        delete ordersById[orderId];
        delete orderMarketKey[orderId];

        emit OrderCancelled(orderId);
    }

    // =========================================================
    //  Internal: matching loop for placeOrder
    // =========================================================

    function _checkAndRecordOrderLimit(address user, bytes32 marketKey) internal {
        if (block.number != lastOrderBlock[user][marketKey]) {
            ordersInBlock[user][marketKey] = 0;
            lastOrderBlock[user][marketKey] = block.number;
        }

        if (ordersInBlock[user][marketKey] >= maxOrdersPerBlock) {
            emit RateLimitHit(user, marketKey, block.number);
            revert TooManyOrdersThisBlock();
        }

        ordersInBlock[user][marketKey]++;

        if (unmatchedOrderCount[user][marketKey] >= maxUnmatchedOrders) {
            revert TooManyOpenOrders();
        }
    }

    function _markOrderInBook(uint256 orderId) internal {
        if (isOrderInBook[orderId]) return;

        Order storage o = ordersById[orderId];

        isOrderInBook[orderId] = true;
        unmatchedOrderCount[o.user][orderMarketKey[orderId]]++;
    }

    function _clearRestingOrderCount(uint256 orderId) internal {
        if (!isOrderInBook[orderId]) return;

        Order storage o = ordersById[orderId];
        bytes32 marketKey = orderMarketKey[orderId];

        isOrderInBook[orderId] = false;

        if (unmatchedOrderCount[o.user][marketKey] > 0) {
            unmatchedOrderCount[o.user][marketKey]--;
        }
    }

    function _isValidIntent(OrderIntent intent) internal pure returns (bool) {
        return
            intent == OrderIntent.BuyOption ||
            intent == OrderIntent.SellOption ||
            intent == OrderIntent.WriteOption ||
            intent == OrderIntent.SellWriter;
    }

    function _matchAgainstBook(
        bytes32 marketKey,
        uint256 takerOrderId,
        uint256[] storage book,
        bool isTakerLong
    ) internal {
        Order storage taker = ordersById[takerOrderId];
        if (taker.orderId == 0) return;

        for (uint256 i = 0; i < book.length && taker.filled < taker.size; ) {
            uint256 makerOrderId = book[i];
            Order storage maker = ordersById[makerOrderId];

            if (maker.orderId == 0 || isOrderCancelled[makerOrderId]) {
                _removeIdAt(book, i);
                continue;
            }

            if (block.timestamp > maker.expiry) {
                _cancelExpiredMaker(makerOrderId);
                _marketRemoveOpen(marketKey);
                _removeIdAt(book, i);
                continue;
            }

            if (
                (isTakerLong && taker.askPrice < maker.askPrice) ||
                (!isTakerLong && taker.askPrice > maker.askPrice)
            ) break;

            uint256 makerAvailable = maker.size - maker.filled;
            uint256 takerRemaining = taker.size - taker.filled;
            uint256 matchSize = takerRemaining < makerAvailable ? takerRemaining : makerAvailable;

            uint256 grossPremium = (matchSize * maker.askPrice) / WAD;

            // Track premium spent for the LONG-side order (premium payer) to later refund rounding dust
            if (isTakerLong) {
                // taker is BuyOption => taker pays premium from locked budget
                taker.premiumSpent += grossPremium;
                if (taker.premiumSpent > taker.premiumLocked) {
                    revert PremiumSpentExceedsLocked();
                }
            } else if (_isLongSide(maker.intent)) {
                // maker is BuyOption => maker pays premium from locked budget
                maker.premiumSpent += grossPremium;
                if (maker.premiumSpent > maker.premiumLocked) {
                    revert PremiumSpentExceedsLocked();
                }
            }

            address premiumPayer;
            address premiumReceiver;

            if (taker.intent == OrderIntent.SellWriter && maker.intent == OrderIntent.WriteOption) {
                // Existing writer/taker sells writer position.
                // New writer/maker pays premium to existing writer/taker.
                premiumPayer = maker.user;
                premiumReceiver = taker.user;
            } else if (
                taker.intent == OrderIntent.WriteOption && maker.intent == OrderIntent.SellWriter
            ) {
                // Existing writer/maker sells writer position.
                // New writer/taker pays premium to existing writer/maker.
                premiumPayer = taker.user;
                premiumReceiver = maker.user;
            } else {
                premiumPayer = isTakerLong ? taker.user : maker.user;
                premiumReceiver = isTakerLong ? maker.user : taker.user;
            }

            _transferTokenOrETH(
                premiumPayer,
                premiumReceiver,
                maker.paymentToken,
                grossPremium,
                "option_premium"
            );

            Order storage feeOrder = isTakerLong ? taker : maker;
            uint256 feeChargedThisStep = 0;
            if (_isLongSide(feeOrder.intent)) {
                feeChargedThisStep = _chargeFeesForFillExact(feeOrder, premiumPayer, matchSize);
            }

            emit OrderMatched(
                taker.orderId,
                maker.orderId,
                matchSize,
                grossPremium,
                feeChargedThisStep,
                grossPremium
            );

            // Position updates (unchanged)
            if (taker.intent == OrderIntent.BuyOption && maker.intent == OrderIntent.WriteOption) {
                optionContract.registerNewOption(
                    maker.optionType,
                    maker.assetToken,
                    maker.paymentToken,
                    maker.strikePrice,
                    maker.optionExpiry,
                    maker.user,
                    taker.user,
                    matchSize
                );
            } else if (
                taker.intent == OrderIntent.BuyOption && maker.intent == OrderIntent.SellOption
            ) {
                optionContract.releasePositionReservation(marketKey, maker.user, matchSize, false);
                optionContract.transferPosition(
                    marketKey,
                    maker.user,
                    taker.user,
                    matchSize,
                    false
                );
            } else if (
                taker.intent == OrderIntent.SellWriter && maker.intent == OrderIntent.WriteOption
            ) {
                optionContract.releasePositionReservation(marketKey, taker.user, matchSize, true);
                _transferWriterCollateral(maker, taker.user, maker.user, matchSize);
                optionContract.transferPosition(marketKey, taker.user, maker.user, matchSize, true);
            } else if (
                taker.intent == OrderIntent.WriteOption && maker.intent == OrderIntent.BuyOption
            ) {
                optionContract.registerNewOption(
                    maker.optionType,
                    maker.assetToken,
                    maker.paymentToken,
                    maker.strikePrice,
                    maker.optionExpiry,
                    taker.user,
                    maker.user,
                    matchSize
                );
            } else if (
                taker.intent == OrderIntent.SellOption && maker.intent == OrderIntent.BuyOption
            ) {
                optionContract.releasePositionReservation(marketKey, taker.user, matchSize, false);
                optionContract.transferPosition(
                    marketKey,
                    taker.user,
                    maker.user,
                    matchSize,
                    false
                );
            } else if (
                taker.intent == OrderIntent.WriteOption && maker.intent == OrderIntent.SellWriter
            ) {
                optionContract.releasePositionReservation(marketKey, maker.user, matchSize, true);
                _transferWriterCollateral(maker, maker.user, taker.user, matchSize);
                optionContract.transferPosition(marketKey, maker.user, taker.user, matchSize, true);
            } else {
                revert UnsupportedPairing();
            }

            taker.filled += matchSize;
            maker.filled += matchSize;

            if (maker.filled == maker.size) {
                _clearRestingOrderCount(makerOrderId);
                _finalizeFilled(makerOrderId);
                _marketRemoveOpen(marketKey);
                _removeIdAt(book, i);
            } else {
                i++;
            }
        }
    }

    // =========================================================
    //  Fees
    // =========================================================
    function _getFeesForPremium(
        address feeToken,
        address paymentToken,
        uint256 grossPremium,
        address account,
        bool isMaker
    )
        internal
        view
        returns (uint256 fixedAmt, address fixedToken, uint256 pctAmt, address pctToken)
    {
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            feeToken,
            paymentToken,
            grossPremium,
            FEE_CONTEXT_OPTIONS,
            account,
            isMaker
        );

        return (f.fixedAmount, f.fixedToken, f.percentageAmount, f.percentageToken);
    }

    function _chargeFeesForFillExact(
        Order storage feeOrder,
        address premiumPayer,
        uint256 matchSize
    ) internal returns (uint256 chargedThisStep) {
        if (!_isLongSide(feeOrder.intent)) return 0;

        if (!feeOrder.fixedFeeCharged) {
            if (feeOrder.fixedFeeTotal > 0) {
                vault.chargeFee(
                    premiumPayer,
                    feeOrder.fixedFeeToken,
                    feeOrder.fixedFeeTotal,
                    "option_trade_fee_fixed",
                    true
                );
                chargedThisStep += feeOrder.fixedFeeTotal;
            }
            feeOrder.fixedFeeCharged = true;
        }

        if (feeOrder.pctFeeTotal == 0) return chargedThisStep;

        uint256 filledBefore = feeOrder.filled;
        uint256 filledAfter = filledBefore + matchSize;

        if (filledAfter >= feeOrder.size) {
            uint256 remainder = feeOrder.pctFeeTotal - feeOrder.pctFeeCharged;
            if (remainder > 0) {
                vault.chargeFee(
                    premiumPayer,
                    feeOrder.pctFeeToken,
                    remainder,
                    "option_trade_fee_pct",
                    false
                );
                feeOrder.pctFeeCharged = feeOrder.pctFeeTotal;
                chargedThisStep += remainder;
            }
            return chargedThisStep;
        }

        uint256 pctTargetAfter = (feeOrder.pctFeeTotal * filledAfter) / feeOrder.size;

        if (pctTargetAfter > feeOrder.pctFeeCharged) {
            uint256 delta = pctTargetAfter - feeOrder.pctFeeCharged;
            vault.chargeFee(
                premiumPayer,
                feeOrder.pctFeeToken,
                delta,
                "option_trade_fee_pct",
                false
            );
            feeOrder.pctFeeCharged = pctTargetAfter;
            chargedThisStep += delta;
        }

        return chargedThisStep;
    }

    // =========================================================
    //  Locking / Snapshot
    // =========================================================
    function _lockAndMaybeSnapshotFees(Order storage o, bool isMakerFee) internal {
        if (o.intent == OrderIntent.WriteOption) {
            if (o.optionType == OptionContract.OptionType.Call) {
                _lockTokenOrETH(o.user, o.assetToken, o.size);
            } else {
                uint256 quoteCollateral = (o.size * o.strikePrice) / WAD;
                _lockTokenOrETH(o.user, o.paymentToken, quoteCollateral);
            }
            return;
        }

        if (o.intent == OrderIntent.BuyOption) {
            uint256 premiumBudget = (o.size * o.askPrice) / WAD;
            _lockTokenOrETH(o.user, o.paymentToken, premiumBudget);
            _snapshotBuyFees(o, premiumBudget, isMakerFee);
            return;
        }

        if (o.intent == OrderIntent.SellOption || o.intent == OrderIntent.SellWriter) {
            bytes32 marketKey = optionContract.computeMarketKey(
                o.optionType,
                o.assetToken,
                o.paymentToken,
                o.strikePrice,
                o.optionExpiry
            );
            optionContract.reservePosition(
                marketKey,
                o.user,
                o.size,
                o.intent == OrderIntent.SellWriter
            );
        }
    }

    function _snapshotBuyFees(Order storage o, uint256 premiumBudget, bool isMakerFee) internal {
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            o.feeToken,
            o.paymentToken,
            premiumBudget,
            FEE_CONTEXT_OPTIONS,
            o.user,
            isMakerFee
        );

        o.fixedFeeToken = f.fixedToken;
        o.fixedFeeTotal = f.fixedAmount;
        o.fixedFeeCharged = false;
        o.pctFeeToken = f.percentageToken;
        o.pctFeeTotal = f.percentageAmount;
        o.pctFeeCharged = 0;
        o.premiumLocked = premiumBudget;
        o.premiumSpent = 0;

        if (o.fixedFeeTotal > 0) _lockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        if (o.pctFeeTotal > 0) _lockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal);
    }

    function _lockForAccept(
        Order storage maker,
        uint256 amount,
        address payerFeeToken,
        bool makerIsLong
    ) internal {
        uint256 grossPremium = (amount * maker.askPrice) / WAD;

        if (!makerIsLong) {
            _lockTokenOrETH(msg.sender, maker.paymentToken, grossPremium);

            (
                uint256 fixedAmt,
                address fixedToken,
                uint256 pctAmt,
                address pctToken
            ) = _getFeesForPremium(
                    payerFeeToken,
                    maker.paymentToken,
                    grossPremium,
                    msg.sender,
                    false
                );

            if (fixedAmt > 0) _lockTokenOrETH(msg.sender, fixedToken, fixedAmt);
            if (pctAmt > 0) _lockTokenOrETH(msg.sender, pctToken, pctAmt);
        }

        if (maker.intent == OrderIntent.BuyOption) {
            (, uint256 holderSize, uint256 holderExercised) = optionContract.getUserPosition(
                orderMarketKey[maker.orderId],
                msg.sender
            );

            uint256 holderAvail = holderSize > holderExercised ? (holderSize - holderExercised) : 0;

            if (holderAvail < amount) {
                if (maker.optionType == OptionContract.OptionType.Call) {
                    _lockTokenOrETH(msg.sender, maker.assetToken, amount);
                } else {
                    uint256 quoteCollateral = (amount * maker.strikePrice) / WAD;
                    _lockTokenOrETH(msg.sender, maker.paymentToken, quoteCollateral);
                }
            }
        }
    }

    function _resnapshotUnfilledBuyFeesAsMaker(Order storage o) internal {
        if (o.intent != OrderIntent.BuyOption || o.filled != 0) return;
        if (o.fixedFeeTotal > 0) _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        if (o.pctFeeTotal > 0) _unlockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal);
        _snapshotBuyFees(o, (o.size * o.askPrice) / WAD, true);
    }

    // =========================================================
    //  Unlocking (FIXED: uses STORAGE order)
    // =========================================================
    function _unlockOnCancel(Order storage order, uint256 remaining) internal {
        if (remaining == 0) return;

        if (order.intent == OrderIntent.WriteOption) {
            if (order.optionType == OptionContract.OptionType.Call) {
                _unlockTokenOrETH(order.user, order.assetToken, remaining);
            } else {
                uint256 quoteAmt = (remaining * order.strikePrice) / WAD;
                _unlockTokenOrETH(order.user, order.paymentToken, quoteAmt);
            }
            return;
        }

        if (order.intent == OrderIntent.BuyOption) {
            uint256 premiumRemain =
                order.premiumLocked > order.premiumSpent
                    ? (order.premiumLocked - order.premiumSpent)
                    : 0;

            if (premiumRemain > 0) {
                _unlockTokenOrETH(order.user, order.paymentToken, premiumRemain);
                order.premiumSpent = order.premiumLocked; // defensive
            }

            if (!order.fixedFeeCharged && order.fixedFeeTotal > 0) {
                _unlockTokenOrETH(order.user, order.fixedFeeToken, order.fixedFeeTotal);
                order.fixedFeeCharged = true; // defensive
            }

            uint256 pctRemain =
                order.pctFeeTotal > order.pctFeeCharged
                    ? (order.pctFeeTotal - order.pctFeeCharged)
                    : 0;

            if (pctRemain > 0) {
                _unlockTokenOrETH(order.user, order.pctFeeToken, pctRemain);
                order.pctFeeCharged = order.pctFeeTotal; // defensive
            }

            return;
        }

        if (order.intent == OrderIntent.SellOption) {
            bytes32 marketKey = optionContract.computeMarketKey(
                order.optionType,
                order.assetToken,
                order.paymentToken,
                order.strikePrice,
                order.optionExpiry
            );

            optionContract.releasePositionReservation(marketKey, order.user, remaining, false);
            return;
        }

        if (order.intent == OrderIntent.SellWriter) {
            bytes32 marketKey = optionContract.computeMarketKey(
                order.optionType,
                order.assetToken,
                order.paymentToken,
                order.strikePrice,
                order.optionExpiry
            );

            optionContract.releasePositionReservation(marketKey, order.user, remaining, true);
            return;
        }
    }

    function _cancelExpiredMaker(uint256 makerOrderId) internal {
        if (isOrderCancelled[makerOrderId]) return;

        Order storage maker = ordersById[makerOrderId];
        if (maker.orderId == 0) return;

        uint256 remaining = maker.size - maker.filled;

        // IMPORTANT: unlock using storage-backed fee progress
        _unlockOnCancel(maker, remaining);

        _clearRestingOrderCount(makerOrderId);

        isOrderCancelled[makerOrderId] = true;
        delete ordersById[makerOrderId];
        delete orderMarketKey[makerOrderId];

        emit OrderExpiredCancelled(makerOrderId);
    }

    // =========================================================
    //  Vault helpers
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

    function _transferTokenOrETH(
        address from,
        address to,
        address token,
        uint256 amount,
        string memory reason
    ) internal {
        if (amount == 0) return;
        if (token == address(0)) vault.transferETH(from, to, amount, reason);
        else vault.transferToken(from, to, token, amount, reason);
    }

    function _transferWriterCollateral(
        Order storage marketOrder,
        address from,
        address to,
        uint256 amount
    ) internal {
        if (marketOrder.optionType == OptionContract.OptionType.Call) {
            if (marketOrder.assetToken == address(0)) {
                vault.transferLockedETH(from, to, amount, "option_writer_collateral_transfer");
            } else {
                vault.transferLockedERC20(
                    from,
                    to,
                    marketOrder.assetToken,
                    amount,
                    "option_writer_collateral_transfer"
                );
            }
        } else {
            uint256 quoteCollateral = (amount * marketOrder.strikePrice) / WAD;

            if (marketOrder.paymentToken == address(0)) {
                vault.transferLockedETH(
                    from,
                    to,
                    quoteCollateral,
                    "option_writer_collateral_transfer"
                );
            } else {
                vault.transferLockedERC20(
                    from,
                    to,
                    marketOrder.paymentToken,
                    quoteCollateral,
                    "option_writer_collateral_transfer"
                );
            }
        }
    }

    // =========================================================
    //  Book ops
    // =========================================================
    function _isLongSide(OrderIntent intent) internal pure returns (bool) {
        return intent == OrderIntent.BuyOption;
    }

    function _insertSorted(uint256[] storage book, uint256 orderId, bool isLongSide_) internal {
        uint256 index = book.length;
        uint256 price = ordersById[orderId].askPrice;

        for (uint256 i = 0; i < book.length; i++) {
            uint256 otherId = book[i];
            uint256 otherPrice = ordersById[otherId].askPrice;

            if ((isLongSide_ && price > otherPrice) || (!isLongSide_ && price < otherPrice)) {
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

        // shift left to preserve ordering
        for (uint256 i = index; i + 1 < len; i++) {
            book[i] = book[i + 1];
        }
        book.pop();
    }

    function _finalizeFilled(uint256 orderId) internal {
        Order storage o = ordersById[orderId];
        if (o.orderId != 0) {
            _unlockRemaindersOnFullFill(o);
        }
        delete ordersById[orderId];
        delete orderMarketKey[orderId];
    }

    function _unlockRemaindersOnFullFill(Order storage o) internal {
        if (!_isLongSide(o.intent)) return;

        // Premium dust refund (floor division drift across partial fills)
        uint256 premRemain =
            o.premiumLocked > o.premiumSpent ? (o.premiumLocked - o.premiumSpent) : 0;
        if (premRemain > 0) {
            _unlockTokenOrETH(o.user, o.paymentToken, premRemain);
            // defensive: prevent double-unlock if called twice
            o.premiumSpent = o.premiumLocked;
        }

        // Fixed fee budget: unlock if never charged
        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
            o.fixedFeeCharged = true; // defensive
        }

        // Pct fee budget: unlock uncharged remainder (should be 0 at full fill, but defensive)
        uint256 pctRemain = o.pctFeeTotal > o.pctFeeCharged ? (o.pctFeeTotal - o.pctFeeCharged) : 0;
        if (pctRemain > 0) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, pctRemain);
            o.pctFeeCharged = o.pctFeeTotal; // defensive
        }
    }

    function _marketAddOpen(bytes32 marketKey) internal {
        uint256 c = openOrderCountByMarket[marketKey] + 1;
        openOrderCountByMarket[marketKey] = c;

        if (c == 1) {
            activeMarkets.push(marketKey);
            activeMarketIndexPlus1[marketKey] = activeMarkets.length; // 1-based
        }
    }

    function _marketRemoveOpen(bytes32 marketKey) internal {
        uint256 c = openOrderCountByMarket[marketKey];
        if (c == 0) return;

        c -= 1;
        openOrderCountByMarket[marketKey] = c;

        if (c == 0) {
            uint256 idx1 = activeMarketIndexPlus1[marketKey];
            if (idx1 == 0) return;

            uint256 idx = idx1 - 1;
            uint256 lastIdx = activeMarkets.length - 1;

            if (idx != lastIdx) {
                bytes32 lastKey = activeMarkets[lastIdx];
                activeMarkets[idx] = lastKey;
                activeMarketIndexPlus1[lastKey] = idx + 1;
            }

            activeMarkets.pop();
            activeMarketIndexPlus1[marketKey] = 0;
        }
    }

    function getActiveMarketsCount() external view returns (uint256) {
        return activeMarkets.length;
    }

    function getActiveMarketsPaged(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory out) {
        uint256 n = activeMarkets.length;
        if (offset >= n) return new bytes32[](0);

        uint256 end = offset + limit;
        if (end > n) end = n;

        out = new bytes32[](end - offset);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = activeMarkets[offset + i];
        }
    }

    function getActiveMarketOrderCount(bytes32 marketKey) external view returns (uint256) {
        return openOrderCountByMarket[marketKey];
    }
}
