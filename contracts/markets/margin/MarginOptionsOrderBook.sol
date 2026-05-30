// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { MarginOptionContract } from "./MarginOptionContract.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

/**
 * @notice Minimal orderbook for MarginOptionContract.
 *
 * Kept intentionally close to the option orderbook matching model:
 * - BuyOption  : open/increase a long position
 * - WriteOption: open/increase a short position and mint against new collateral
 * - SellOption : sell an existing long position
 * - SellWriter : sell/transfer an existing short position (collateral responsibility moves too)
 *
 * Differences vs OptionsOrderBook:
 * - market params are pre-created in MarginOptionContract; orders trade by marketKey only
 *
 * Fee rules:
 * - Only BuyOption (the premium payer for holder exposure) pays trading fees.
 * - Writer / seller-side orders do not pay trading fees.
 * - Stored BuyOption orders snapshot and lock fees at placement.
 * - Fixed fee is charged once per premium-payer order.
 * - Percentage fee is charged pro-rata by filled size, with exact remainder on final fill.
 * - BuyOption takers accepting WriteOption/SellOption makers pay fees in that accept tx.
 */
contract MarginOptionsOrderBook is AccessControl {
    error ZeroAddress();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidExpiry();
    error MarketNotInitialized();
    error MarketIsClosed();
    error MarketExpired();
    error MarketUnavailable();
    error OrderIsCancelled();
    error OrderDoesNotExist();
    error MakerExpired();
    error SelfTrade();
    error InsufficientOrderSize();
    error PremiumSpentExceedsLocked();
    error UnsupportedPairing();
    error UnsupportedIntent();
    error OrderNotInBook();
    error AlreadyCancelled();
    error NotOrderOwner();

    error TooManyOrdersThisBlock();
    error TooManyOpenOrders();
    error InvalidOrderLimits();

    enum OrderIntent {
        BuyOption,
        SellOption,
        WriteOption,
        SellWriter
    }

    uint256 public constant WAD = 1e18;
    uint256 public nextOrderId = 1;

    uint256 public maxOrdersPerBlock;
    uint256 public maxUnmatchedOrders;

    mapping(address => mapping(bytes32 => uint256)) public lastOrderBlock;
    mapping(address => mapping(bytes32 => uint256)) public ordersInBlock;
    mapping(address => mapping(bytes32 => uint256)) public unmatchedOrderCount;
    mapping(uint256 => bool) public isOrderInBook;

    struct Order {
        uint256 orderId;
        address user;
        bytes32 marketKey;
        OrderIntent intent;
        uint256 size;
        uint256 filled;
        uint256 askPrice; // premium per unit in quote token (WAD based)
        uint256 expiry;
        uint256 timestamp;
        // Preferred fee payment token for BuyOption orders.
        address feeToken;
        // Fee snapshot for stored BuyOption orders only.
        address fixedFeeToken;
        uint256 fixedFeeTotal;
        bool fixedFeeCharged;
        address pctFeeToken;
        uint256 pctFeeTotal;
        uint256 pctFeeCharged;
        // Premium budget tracking for stored BuyOption orders only.
        uint256 premiumLocked;
        uint256 premiumSpent;
    }

    SethxVault public immutable vault;
    MarginOptionContract public immutable marginOptionContract;
    FeeManager public immutable feeManager;
    AccountRegistry public immutable accountRegistry;

    string public constant FEE_CONTEXT_MARGIN_OPTIONS = "Margin Option Trade";

    mapping(uint256 => Order) public ordersById;
    mapping(uint256 => bytes32) public orderMarketKey;
    mapping(uint256 => bool) public isOrderCancelled;
    mapping(address => uint256[]) private userOrders;

    mapping(bytes32 => uint256[]) public longSideBook;
    mapping(bytes32 => uint256[]) public shortSideBook;

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
        uint256 indexed takerOrderId,
        uint256 indexed makerOrderId,
        bytes32 indexed marketKey,
        uint256 size,
        uint256 grossPremium,
        uint256 totalFeeCharged
    );
    event OrderCancelled(uint256 indexed orderId);
    event OrderExpiredCancelled(uint256 indexed orderId);

    event OrderLimitsSet(uint256 maxOrdersPerBlock, uint256 maxUnmatchedOrders);

    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }

        _;
    }

    constructor(
        address _vault,
        address _accountRegistry,
        address _marginOptionContract,
        address _feeManager,
        address admin
    ) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_marginOptionContract == address(0)) revert ZeroAddress();
        if (_feeManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        marginOptionContract = MarginOptionContract(_marginOptionContract);
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

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return ordersById[orderId];
    }

    function getOpenOrders(
        bytes32 marketKey,
        bool isLongSide_
    ) external view returns (Order[] memory out) {
        uint256[] storage ids = isLongSide_ ? longSideBook[marketKey] : shortSideBook[marketKey];
        out = new Order[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = ordersById[ids[i]];
    }

    function placeOrder(
        bytes32 marketKey,
        OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 orderExpiry,
        address feeToken
    ) external onlyAccount {
        _placeOrder(marketKey, intent, size, askPrice, orderExpiry, feeToken);
    }

    function placeOrderForMarket(
        string calldata ticker,
        MarginOptionContract.OptionType optionType,
        address oracle,
        uint256 strikePrice,
        uint256 marketExpiry,
        uint256 collateralBps,
        OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 orderExpiry,
        address feeToken
    ) external onlyAccount {
        (bytes32 marketKey,,) = marginOptionContract.previewMarketKey(optionType, oracle, strikePrice, marketExpiry, collateralBps);
        MarginOptionContract.MarketConfig memory existing = marginOptionContract.getMarket(marketKey);
        if (!existing.initialized) {
            marketKey = marginOptionContract.createMarket(ticker, optionType, oracle, strikePrice, marketExpiry, collateralBps);
        }
        _placeOrder(marketKey, intent, size, askPrice, orderExpiry, feeToken);
    }

    function _placeOrder(
        bytes32 marketKey,
        OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 orderExpiry,
        address feeToken
    ) internal {
        if (size == 0) revert InvalidAmount();
        if (askPrice == 0) revert InvalidPrice();
        if (orderExpiry <= block.timestamp) revert InvalidExpiry();

        MarginOptionContract.MarketConfig memory m = marginOptionContract.getMarket(marketKey);
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.active) revert MarketIsClosed();
        if (block.timestamp >= m.expiry) revert MarketExpired();
        if (orderExpiry > m.expiry) revert InvalidExpiry();

        _checkAndRecordOrderLimit(msg.sender, marketKey);

        uint256 orderId = nextOrderId++;
        Order storage o = ordersById[orderId];
        o.orderId = orderId;
        o.user = msg.sender;
        o.marketKey = marketKey;
        o.intent = intent;
        o.size = size;
        o.askPrice = askPrice;
        o.expiry = orderExpiry;
        o.timestamp = block.timestamp;
        o.feeToken = feeToken;

        orderMarketKey[orderId] = marketKey;
        userOrders[msg.sender].push(orderId);

        _lockForOrder(o, m.paymentToken);

        bool isLongSide_ = _isLongSide(intent);
        uint256[] storage opposite =
            isLongSide_ ? shortSideBook[marketKey] : longSideBook[marketKey];
        _matchAgainstBook(marketKey, orderId, opposite, isLongSide_, m.paymentToken);

        if (
            ordersById[orderId].orderId != 0 &&
            ordersById[orderId].filled < ordersById[orderId].size
        ) {
            _resnapshotUnfilledBuyFeesAsMaker(ordersById[orderId], m.paymentToken);

            uint256[] storage sameSide =
                isLongSide_ ? longSideBook[marketKey] : shortSideBook[marketKey];

            _insertSorted(sameSide, orderId, isLongSide_);
            _markOrderInBook(orderId);
        } else {
            _finalizeFilled(orderId);
        }

        emit OrderPlaced(orderId, msg.sender, marketKey, intent, size, askPrice, feeToken);
    
    }

    function acceptOrder(
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyAccount {
        if (amount == 0) revert InvalidAmount();
        if (isOrderCancelled[makerOrderId]) revert OrderIsCancelled();

        Order storage maker = ordersById[makerOrderId];
        if (maker.orderId == 0) revert OrderDoesNotExist();
        if (block.timestamp > maker.expiry) revert MakerExpired();
        if (maker.user == msg.sender) revert SelfTrade();

        bytes32 marketKey = maker.marketKey;
        MarginOptionContract.MarketConfig memory m = marginOptionContract.getMarket(marketKey);
        if (!m.initialized || !m.active) revert MarketUnavailable();
        if (block.timestamp >= m.expiry) revert MarketExpired();

        uint256 available = maker.size - maker.filled;
        if (available < amount) revert InsufficientOrderSize();

        OrderIntent takerIntent = _oppositeOf(maker.intent);
        bool isSellWriterTake =
            maker.intent == OrderIntent.SellWriter && takerIntent == OrderIntent.WriteOption;

        if (isSellWriterTake) {
            uint256 premiumBudget = (amount * maker.askPrice) / WAD;
            _lockTokenOrETH(msg.sender, m.paymentToken, premiumBudget);
        } else {
            _lockForImmediateTake(
                msg.sender,
                takerIntent,
                marketKey,
                amount,
                maker.askPrice,
                m.paymentToken,
                feeToken
            );
        }
        _executeMatch(
            0,
            makerOrderId,
            marketKey,
            takerIntent,
            msg.sender,
            maker.user,
            amount,
            maker.askPrice,
            m.paymentToken,
            feeToken
        );

        maker.filled += amount;
        if (maker.filled == maker.size) {
            uint256[] storage book =
                _isLongSide(maker.intent) ? longSideBook[marketKey] : shortSideBook[marketKey];

            _clearRestingOrderCount(makerOrderId);
            _removeOrderIdFromBook(book, makerOrderId);
            _finalizeFilled(makerOrderId);
        }
    }

    function cancelOrder(uint256 orderId) external onlyAccount {
        if (isOrderCancelled[orderId]) revert AlreadyCancelled();

        Order storage o = ordersById[orderId];
        if (o.orderId == 0) revert OrderDoesNotExist();
        if (o.user != msg.sender) revert NotOrderOwner();

        bytes32 marketKey = o.marketKey;
        uint256 remaining = o.size - o.filled;
        MarginOptionContract.MarketConfig memory m = marginOptionContract.getMarket(marketKey);

        uint256[] storage book =
            _isLongSide(o.intent) ? longSideBook[marketKey] : shortSideBook[marketKey];
        _removeOrderIdFromBook(book, orderId);
        _unlockOnCancel(o, remaining, m.paymentToken);

        _clearRestingOrderCount(orderId);

        isOrderCancelled[orderId] = true;
        delete ordersById[orderId];
        delete orderMarketKey[orderId];

        emit OrderCancelled(orderId);
    }

    function _matchAgainstBook(
        bytes32 marketKey,
        uint256 takerOrderId,
        uint256[] storage book,
        bool isTakerLong,
        address quoteToken
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
                _cancelExpiredMaker(makerOrderId, quoteToken);
                _removeIdAt(book, i);
                continue;
            }
            if (
                (isTakerLong && taker.askPrice < maker.askPrice) ||
                (!isTakerLong && taker.askPrice > maker.askPrice)
            ) {
                break;
            }

            uint256 makerAvail = maker.size - maker.filled;
            uint256 takerAvail = taker.size - taker.filled;
            uint256 matchSize = makerAvail < takerAvail ? makerAvail : takerAvail;

            _executeMatch(
                takerOrderId,
                makerOrderId,
                marketKey,
                taker.intent,
                taker.user,
                maker.user,
                matchSize,
                maker.askPrice,
                quoteToken,
                taker.feeToken
            );

            taker.filled += matchSize;
            maker.filled += matchSize;

            if (maker.filled == maker.size) {
                _clearRestingOrderCount(makerOrderId);
                _finalizeFilled(makerOrderId);
                _removeIdAt(book, i);
            } else {
                i++;
            }
        }
    }

    function _executeMatch(
        uint256 takerOrderId,
        uint256 makerOrderId,
        bytes32 marketKey,
        OrderIntent takerIntent,
        address takerUser,
        address makerUser,
        uint256 size,
        uint256 makerPrice,
        address quoteToken,
        address takerFeeToken
    ) internal returns (uint256 totalFeeCharged) {
        uint256 grossPremium = (size * makerPrice) / WAD;

        Order storage maker = ordersById[makerOrderId];

        address premiumPayer;
        address premiumReceiver;

        if (maker.intent == OrderIntent.SellWriter && takerIntent == OrderIntent.WriteOption) {
            // Existing writer sells/transfers the writer position.
            // New writer/taker pays premium to original writer/maker.
            premiumPayer = takerUser;
            premiumReceiver = makerUser;
        } else if (
            takerIntent == OrderIntent.SellWriter && maker.intent == OrderIntent.WriteOption
        ) {
            // Taker/current writer sells/transfers writer position into maker's write-side order.
            // Maker/new writer pays premium to taker/original writer.
            premiumPayer = makerUser;
            premiumReceiver = takerUser;
        } else {
            bool takerPaysPremium = _isLongSide(takerIntent);
            premiumPayer = takerPaysPremium ? takerUser : makerUser;
            premiumReceiver = takerPaysPremium ? makerUser : takerUser;
        }

        _transferTokenOrETH(
            premiumPayer,
            premiumReceiver,
            quoteToken,
            grossPremium,
            "margin_option_premium"
        );

        if (takerIntent == OrderIntent.BuyOption && takerOrderId != 0) {
            Order storage taker = ordersById[takerOrderId];
            taker.premiumSpent += grossPremium;
            if (taker.premiumSpent > taker.premiumLocked) {
                revert PremiumSpentExceedsLocked();
            }
            totalFeeCharged = _chargeFeesForFillExact(taker, premiumPayer, size);
        } else if (maker.intent == OrderIntent.BuyOption) {
            maker.premiumSpent += grossPremium;
            if (maker.premiumSpent > maker.premiumLocked) {
                revert PremiumSpentExceedsLocked();
            }
            totalFeeCharged = _chargeFeesForFillExact(maker, premiumPayer, size);
        } else if (takerIntent == OrderIntent.BuyOption) {
            totalFeeCharged = _chargeImmediateBuyFees(
                premiumPayer,
                takerFeeToken,
                quoteToken,
                grossPremium
            );
        }

        if (takerIntent == OrderIntent.BuyOption && maker.intent == OrderIntent.WriteOption) {
            marginOptionContract.registerNewPosition(marketKey, makerUser, takerUser, size);
        } else if (
            takerIntent == OrderIntent.WriteOption && maker.intent == OrderIntent.BuyOption
        ) {
            marginOptionContract.registerNewPosition(marketKey, takerUser, makerUser, size);
        } else if (takerIntent == OrderIntent.BuyOption && maker.intent == OrderIntent.SellOption) {
            marginOptionContract.releaseHolderPositionReservation(marketKey, makerUser, size);
            marginOptionContract.transferHolderPosition(marketKey, makerUser, takerUser, size);
        } else if (takerIntent == OrderIntent.SellOption && maker.intent == OrderIntent.BuyOption) {
            marginOptionContract.releaseHolderPositionReservation(marketKey, takerUser, size);
            marginOptionContract.transferHolderPosition(marketKey, takerUser, makerUser, size);
        } else if (
            takerIntent == OrderIntent.SellWriter && maker.intent == OrderIntent.WriteOption
        ) {
            uint256 marginAmount = marginOptionContract.getRequiredMargin(marketKey, size);

            marginOptionContract.releaseWriterPositionReservation(marketKey, takerUser, size);

            _transferLockedTokenOrETH(
                takerUser,
                makerUser,
                quoteToken,
                marginAmount,
                "MarginOption: SellWriter locked margin transfer"
            );

            marginOptionContract.transferWriterPosition(marketKey, takerUser, makerUser, size);
        } else if (
            takerIntent == OrderIntent.WriteOption && maker.intent == OrderIntent.SellWriter
        ) {
            uint256 marginAmount = marginOptionContract.getRequiredMargin(marketKey, size);

            marginOptionContract.releaseWriterPositionReservation(marketKey, makerUser, size);

            _transferLockedTokenOrETH(
                makerUser,
                takerUser,
                quoteToken,
                marginAmount,
                "MarginOption: SellWriter locked margin transfer"
            );

            marginOptionContract.transferWriterPosition(marketKey, makerUser, takerUser, size);
        } else {
            revert UnsupportedPairing();
        }

        emit OrderMatched(
            takerOrderId,
            makerOrderId,
            marketKey,
            size,
            grossPremium,
            totalFeeCharged
        );
    }

    function _chargeImmediateBuyFees(
        address premiumPayer,
        address feeToken,
        address quoteToken,
        uint256 grossPremium
    ) internal returns (uint256 chargedThisStep) {
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            feeToken,
            quoteToken,
            grossPremium,
            FEE_CONTEXT_MARGIN_OPTIONS,
            premiumPayer,
            false
        );

        if (f.fixedAmount > 0) {
            vault.chargeFee(
                premiumPayer,
                f.fixedToken,
                f.fixedAmount,
                "margin_option_trade_fee_fixed",
                true
            );
            chargedThisStep += f.fixedAmount;
        }

        if (f.percentageAmount > 0) {
            vault.chargeFee(
                premiumPayer,
                f.percentageToken,
                f.percentageAmount,
                "margin_option_trade_fee_pct",
                false
            );
            chargedThisStep += f.percentageAmount;
        }
    }

    function _chargeFeesForFillExact(
        Order storage feeOrder,
        address premiumPayer,
        uint256 matchSize
    ) internal returns (uint256 chargedThisStep) {
        if (feeOrder.intent != OrderIntent.BuyOption) return 0;

        if (!feeOrder.fixedFeeCharged) {
            if (feeOrder.fixedFeeTotal > 0) {
                vault.chargeFee(
                    premiumPayer,
                    feeOrder.fixedFeeToken,
                    feeOrder.fixedFeeTotal,
                    "margin_option_trade_fee_fixed",
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
                    "margin_option_trade_fee_pct",
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
                "margin_option_trade_fee_pct",
                false
            );
            feeOrder.pctFeeCharged = pctTargetAfter;
            chargedThisStep += delta;
        }
    }

    function _lockForOrder(Order storage o, address quoteToken) internal {
        uint256 remaining = o.size - o.filled;
        if (o.intent == OrderIntent.WriteOption) {
            uint256 marginAmount = marginOptionContract.getRequiredMargin(o.marketKey, remaining);
            _lockTokenOrETH(o.user, quoteToken, marginAmount);
            return;
        }

        if (o.intent == OrderIntent.BuyOption) {
            uint256 premiumBudget = (remaining * o.askPrice) / WAD;
            _lockTokenOrETH(o.user, quoteToken, premiumBudget);

            FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
                o.feeToken,
                quoteToken,
                premiumBudget,
                FEE_CONTEXT_MARGIN_OPTIONS,
                o.user,
                false
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
            return;
        }

        if (o.intent == OrderIntent.SellOption) {
            marginOptionContract.reserveHolderPosition(o.marketKey, o.user, remaining);
            return;
        }
        if (o.intent == OrderIntent.SellWriter) {
            marginOptionContract.reserveWriterPosition(o.marketKey, o.user, remaining);
            return;
        }
        revert UnsupportedIntent();
    }

    function _lockForImmediateTake(
        address user,
        OrderIntent intent,
        bytes32 marketKey,
        uint256 amount,
        uint256 makerPrice,
        address quoteToken,
        address feeToken
    ) internal {
        if (intent == OrderIntent.WriteOption) {
            uint256 marginAmount = marginOptionContract.getRequiredMargin(marketKey, amount);
            _lockTokenOrETH(user, quoteToken, marginAmount);
            return;
        }
        if (intent == OrderIntent.BuyOption || intent == OrderIntent.SellWriter) {
            uint256 premiumBudget = (amount * makerPrice) / WAD;
            _lockTokenOrETH(user, quoteToken, premiumBudget);

            if (intent == OrderIntent.BuyOption) {
                FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
                    feeToken,
                    quoteToken,
                    premiumBudget,
                    FEE_CONTEXT_MARGIN_OPTIONS,
                    user,
                    false
                );
                if (f.fixedAmount > 0) _lockTokenOrETH(user, f.fixedToken, f.fixedAmount);
                if (f.percentageAmount > 0) {
                    _lockTokenOrETH(user, f.percentageToken, f.percentageAmount);
                }
            }
            return;
        }
        revert UnsupportedIntent();
    }

    function _resnapshotUnfilledBuyFeesAsMaker(Order storage o, address quoteToken) internal {
        if (o.intent != OrderIntent.BuyOption || o.filled != 0) return;

        if (o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        }
        if (o.pctFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal);
        }

        uint256 premiumBudget = (o.size * o.askPrice) / WAD;
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            o.feeToken,
            quoteToken,
            premiumBudget,
            FEE_CONTEXT_MARGIN_OPTIONS,
            o.user,
            true
        );

        o.fixedFeeToken = f.fixedToken;
        o.fixedFeeTotal = f.fixedAmount;
        o.fixedFeeCharged = false;
        o.pctFeeToken = f.percentageToken;
        o.pctFeeTotal = f.percentageAmount;
        o.pctFeeCharged = 0;

        if (o.fixedFeeTotal > 0) _lockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        if (o.pctFeeTotal > 0) _lockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal);
    }

    function _unlockOnCancel(Order storage order, uint256 remaining, address quoteToken) internal {
        if (remaining == 0) return;

        if (order.intent == OrderIntent.WriteOption) {
            uint256 marginAmount = marginOptionContract.getRequiredMargin(
                order.marketKey,
                remaining
            );
            _unlockTokenOrETH(order.user, quoteToken, marginAmount);
            return;
        }

        if (order.intent == OrderIntent.BuyOption) {
            uint256 premiumRemain =
                order.premiumLocked > order.premiumSpent
                    ? (order.premiumLocked - order.premiumSpent)
                    : 0;

            if (premiumRemain > 0) {
                _unlockTokenOrETH(order.user, quoteToken, premiumRemain);
                order.premiumSpent = order.premiumLocked;
            }

            if (!order.fixedFeeCharged && order.fixedFeeTotal > 0) {
                _unlockTokenOrETH(order.user, order.fixedFeeToken, order.fixedFeeTotal);
                order.fixedFeeCharged = true;
            }

            uint256 pctRemain =
                order.pctFeeTotal > order.pctFeeCharged
                    ? (order.pctFeeTotal - order.pctFeeCharged)
                    : 0;

            if (pctRemain > 0) {
                _unlockTokenOrETH(order.user, order.pctFeeToken, pctRemain);
                order.pctFeeCharged = order.pctFeeTotal;
            }

            return;
        }

        if (order.intent == OrderIntent.SellWriter) {
            marginOptionContract.releaseWriterPositionReservation(
                order.marketKey,
                order.user,
                remaining
            );
            return;
        }

        if (order.intent == OrderIntent.SellOption) {
            marginOptionContract.releaseHolderPositionReservation(
                order.marketKey,
                order.user,
                remaining
            );
            return;
        }
        revert UnsupportedIntent();
    }

    function _cancelExpiredMaker(uint256 makerOrderId, address quoteToken) internal {
        if (isOrderCancelled[makerOrderId]) return;
        Order storage maker = ordersById[makerOrderId];
        if (maker.orderId == 0) return;

        uint256 remaining = maker.size - maker.filled;
        _unlockOnCancel(maker, remaining, quoteToken);

        _clearRestingOrderCount(makerOrderId);

        isOrderCancelled[makerOrderId] = true;
        delete ordersById[makerOrderId];
        delete orderMarketKey[makerOrderId];
        emit OrderExpiredCancelled(makerOrderId);
    }

    function _checkAndRecordOrderLimit(address user, bytes32 marketKey) internal {
        if (block.number != lastOrderBlock[user][marketKey]) {
            ordersInBlock[user][marketKey] = 0;
            lastOrderBlock[user][marketKey] = block.number;
        }

        if (ordersInBlock[user][marketKey] >= maxOrdersPerBlock) {
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
        unmatchedOrderCount[o.user][o.marketKey]++;
    }

    function _clearRestingOrderCount(uint256 orderId) internal {
        if (!isOrderInBook[orderId]) return;

        Order storage o = ordersById[orderId];

        isOrderInBook[orderId] = false;

        if (unmatchedOrderCount[o.user][o.marketKey] > 0) {
            unmatchedOrderCount[o.user][o.marketKey]--;
        }
    }

    function _oppositeOf(OrderIntent intent) internal pure returns (OrderIntent) {
        if (intent == OrderIntent.BuyOption) return OrderIntent.WriteOption;
        if (intent == OrderIntent.WriteOption) return OrderIntent.BuyOption;
        if (intent == OrderIntent.SellOption) return OrderIntent.BuyOption;
        return OrderIntent.WriteOption;
    }

    function _isLongSide(OrderIntent intent) internal pure returns (bool) {
        return intent == OrderIntent.BuyOption;
    }

    function _insertSorted(uint256[] storage book, uint256 orderId, bool isLongSide_) internal {
        uint256 index = book.length;
        uint256 price = ordersById[orderId].askPrice;
        for (uint256 i = 0; i < book.length; i++) {
            uint256 otherPrice = ordersById[book[i]].askPrice;
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
        for (uint256 i = index; i + 1 < len; i++) book[i] = book[i + 1];
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
        if (o.intent != OrderIntent.BuyOption) return;

        uint256 premiumRemain =
            o.premiumLocked > o.premiumSpent ? (o.premiumLocked - o.premiumSpent) : 0;
        if (premiumRemain > 0) {
            MarginOptionContract.MarketConfig memory m = marginOptionContract.getMarket(
                o.marketKey
            );
            _unlockTokenOrETH(o.user, m.paymentToken, premiumRemain);
            o.premiumSpent = o.premiumLocked;
        }

        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
            o.fixedFeeCharged = true;
        }

        uint256 pctRemain = o.pctFeeTotal > o.pctFeeCharged ? (o.pctFeeTotal - o.pctFeeCharged) : 0;
        if (pctRemain > 0) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, pctRemain);
            o.pctFeeCharged = o.pctFeeTotal;
        }
    }

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
        if (token == address(0)) {
            vault.transferETH(from, to, amount, reason);
            return;
        }
        revert UnsupportedIntent();
    }

    function _transferLockedTokenOrETH(
        address from,
        address to,
        address token,
        uint256 amount,
        string memory reason
    ) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.transferLockedETH(from, to, amount, reason);
            return;
        }

        revert UnsupportedIntent();
    }
}
