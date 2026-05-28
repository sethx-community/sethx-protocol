// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { BinaryMarginOptionContract } from "./BinaryMarginOptionContract.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

/**
 * @notice Binary payout-notional orderbook.
 *
 * Quantity model:
 * - Orders trade `payoutAmount`, not contract size.
 * - Writer locks exactly `payoutAmount`.
 * - Buyer pays premium = payoutAmount * askPrice / 1e18.
 *
 * Fee rules:
 * - Only the premium payer pays fees. In this book, that is BUY_OPTION.
 * - Writer / seller side orders do not pay trading fees.
 * - Stored BUY_OPTION orders snapshot and lock fees at placement.
 * - Fixed fee is charged once per premium-payer order.
 * - Percentage fee is charged pro-rata by filled premium, with exact remainder on final fill.
 * - BUY_OPTION takers accepting SELL_OPTION / WRITE_OPTION orders pay fees in that accept tx.
 *
 * Legacy enum note:
 * - SELL_WRITER is kept for compatibility, but disabled here.
 * - To support trading existing writer exposure cleanly, add an explicit BUY_WRITER side.
 */
contract BinaryMarginOptionsOrderBook is AccessControl {
    uint256 public constant WAD = 1e18;

    error ZeroAddress();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidOrderIntent();
    error InvalidExpiry();
    error UnknownMarket();
    error MarketUnavailable();
    error MarketClosed();
    error MarketSettled();
    error MarketExpired();
    error OrderDoesNotExist();
    error OrderNotActive();
    error OrderEmpty();
    error NotOwnerOrExpired();
    error InsufficientOrderPayout();
    error UnmatchableIntents();
    error UnsupportedMakerIntent();
    error UnsupportedIntent();
    error BadHolderRelease();
    error BadHolderReservation();
    error InsufficientHolderPayout();

    error TooManyOrdersThisBlock();
    error TooManyOpenOrders();
    error InvalidOrderLimits();

    enum OrderIntent {
        BUY_OPTION, // bid for holder exposure; premium payer
        SELL_OPTION, // ask selling existing holder exposure
        WRITE_OPTION, // ask creating fresh holder exposure backed by new writer
        SELL_WRITER // reserved / disabled in this rewrite
    }

    struct Order {
        uint256 orderId;
        address user;
        bytes32 marketKey;
        OrderIntent intent;
        uint256 payoutAmount; // remaining payout notional
        uint256 originalPayoutAmount; // original payout notional, used for pro-rata fee accounting
        uint256 askPrice; // premium per 1 payout unit, 1e18 scaled
        uint256 expiry; // 0 = no extra order expiry, market expiry still applies
        bool active;
        // Preferred fee payment token for BUY_OPTION orders.
        address feeToken;
        // Fee snapshot for stored BUY_OPTION orders only.
        address fixedFeeToken;
        uint256 fixedFeeTotal;
        bool fixedFeeCharged;
        address pctFeeToken;
        uint256 pctFeeTotal;
        uint256 pctFeeCharged;
        // Premium budget tracking for stored BUY_OPTION orders only.
        uint256 premiumLocked;
        uint256 premiumSpent;
    }

    SethxVault public immutable vault;
    BinaryMarginOptionContract public immutable marginOptionContract;
    FeeManager public immutable feeManager;
    AccountRegistry public immutable accountRegistry;

    string public constant FEE_CONTEXT_BINARY_OPTIONS = "Binary Option Trade";

    uint256 public nextOrderId = 1;

    uint256 public maxOrdersPerBlock;
    uint256 public maxUnmatchedOrders;

    mapping(address => mapping(bytes32 => uint256)) public lastOrderBlock;
    mapping(address => mapping(bytes32 => uint256)) public ordersInBlock;
    mapping(address => mapping(bytes32 => uint256)) public unmatchedOrderCount;
    mapping(uint256 => bool) public isOrderInBook;

    mapping(uint256 => Order) public orders;
    mapping(bytes32 => uint256[]) internal marketOrderIds;

    // Reservations for resting inventory orders
    mapping(bytes32 => mapping(address => uint256)) public reservedHolderPayout;

    event OrderPlaced(uint256 indexed orderId, address indexed user, address indexed feeToken);
    event OrderMatched(
        uint256 indexed makerOrderId,
        uint256 indexed takerOrderId,
        address indexed takerUser,
        uint256 payoutAmount,
        uint256 premiumAmount,
        uint256 totalFeeCharged
    );
    event OrderCancelled(uint256 indexed orderId);

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
        address _binaryMarginOptionContract,
        address _feeManager,
        address admin
    ) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_binaryMarginOptionContract == address(0)) revert ZeroAddress();
        if (_feeManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        marginOptionContract = BinaryMarginOptionContract(_binaryMarginOptionContract);
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

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getOpenOrders(
        bytes32 marketKey,
        bool wantBidBook
    ) external view returns (Order[] memory out) {
        uint256[] storage ids = marketOrderIds[marketKey];
        uint256 count = 0;

        for (uint256 i = 0; i < ids.length; i++) {
            Order storage o = orders[ids[i]];
            if (!_isOrderOpen(o)) continue;

            bool isBid = _isBidIntent(o.intent);
            if (isBid == wantBidBook) count++;
        }

        out = new Order[](count);
        uint256 k = 0;

        for (uint256 i = 0; i < ids.length; i++) {
            Order storage o = orders[ids[i]];
            if (!_isOrderOpen(o)) continue;

            bool isBid = _isBidIntent(o.intent);
            if (isBid == wantBidBook) {
                out[k] = o;
                k++;
            }
        }
    }

    function placeOrder(
        bytes32 marketKey,
        uint8 intentRaw,
        uint256 payoutAmount,
        uint256 askPrice,
        uint256 expiry,
        address feeToken
    ) external onlyAccount returns (uint256) {
        if (payoutAmount == 0) revert InvalidAmount();
        if (askPrice == 0) revert InvalidPrice();

        if (intentRaw > uint8(type(OrderIntent).max)) revert InvalidOrderIntent();

        OrderIntent intent = OrderIntent(intentRaw);

        if (intent == OrderIntent.SELL_WRITER) revert InvalidOrderIntent();

        (
            bool initialized,
            bool active,
            bool settled,
            address paymentToken,
            uint256 marketExpiry
        ) = marginOptionContract.getMarketTradingData(marketKey);

        if (!initialized) revert UnknownMarket();
        if (!active) revert MarketClosed();
        if (settled) revert MarketSettled();
        if (block.timestamp >= marketExpiry) revert MarketExpired();

        if (expiry != 0) {
            if (block.timestamp >= expiry) revert InvalidExpiry();
            if (expiry > marketExpiry) revert InvalidExpiry();
        }

        _checkAndRecordOrderLimit(msg.sender, marketKey);

        uint256 orderId = nextOrderId++;
        Order storage o = orders[orderId];
        o.orderId = orderId;
        o.user = msg.sender;
        o.marketKey = marketKey;
        o.intent = intent;
        o.payoutAmount = payoutAmount;
        o.originalPayoutAmount = payoutAmount;
        o.askPrice = askPrice;
        o.expiry = expiry;
        o.active = true;
        o.feeToken = feeToken;

        _reserveForOrder(o, paymentToken);

        marketOrderIds[marketKey].push(orderId);

        emit OrderPlaced(orderId, msg.sender, feeToken);

        _attemptMatch(orderId);

        if (_isOrderOpen(orders[orderId])) {
            if (orders[orderId].payoutAmount == payoutAmount) {
                _resnapshotUnfilledBuyFeesAsMaker(orders[orderId], paymentToken);
            }

            _markOrderInBook(orderId);
        }

        return orderId;
    }

    function acceptOrder(
        uint256 makerOrderId,
        uint256 payoutAmount,
        address feeToken
    ) external onlyAccount {
        if (payoutAmount == 0) revert InvalidAmount();

        Order storage maker = orders[makerOrderId];
        if (!_isOrderOpen(maker)) revert OrderDoesNotExist();

        (
            bool initialized,
            bool active,
            bool settled,
            address paymentToken,
            uint256 marketExpiry
        ) = marginOptionContract.getMarketTradingData(maker.marketKey);

        if (!initialized || !active || settled) revert MarketUnavailable();
        if (block.timestamp >= marketExpiry) revert MarketExpired();
        if (maker.payoutAmount < payoutAmount) revert InsufficientOrderPayout();

        OrderIntent takerIntent = _routeAcceptIntent(
            maker.marketKey,
            maker.intent,
            msg.sender,
            payoutAmount
        );

        uint256 takerOrderId = nextOrderId++;
        Order memory taker = Order({
            orderId: takerOrderId,
            user: msg.sender,
            marketKey: maker.marketKey,
            intent: takerIntent,
            payoutAmount: payoutAmount,
            originalPayoutAmount: payoutAmount,
            askPrice: maker.askPrice,
            expiry: 0,
            active: true,
            feeToken: feeToken,
            fixedFeeToken: address(0),
            fixedFeeTotal: 0,
            fixedFeeCharged: false,
            pctFeeToken: address(0),
            pctFeeTotal: 0,
            pctFeeCharged: 0,
            premiumLocked: 0,
            premiumSpent: 0
        });

        _reserveForAccept(taker, paymentToken);

        (uint256 premiumAmount, uint256 totalFeeCharged) = _executeTrade(
            maker,
            taker,
            payoutAmount,
            paymentToken,
            feeToken
        );

        maker.payoutAmount -= payoutAmount;
        if (maker.payoutAmount == 0) {
            maker.active = false;
            _clearRestingOrderCount(makerOrderId);
        }

        emit OrderMatched(
            makerOrderId,
            takerOrderId,
            msg.sender,
            payoutAmount,
            premiumAmount,
            totalFeeCharged
        );
    }

    function cancelOrder(uint256 orderId) external {
        Order storage o = orders[orderId];

        if (!o.active) revert OrderNotActive();
        if (o.user == address(0)) revert OrderDoesNotExist();
        if (o.payoutAmount == 0) revert OrderEmpty();

        bool isOwner = msg.sender == o.user;
        bool isExpired = o.expiry != 0 && block.timestamp > o.expiry;

        if (!isOwner && !isExpired) revert NotOwnerOrExpired();

        address paymentToken = address(0);

        _releaseForOrder(o, paymentToken);

        _clearRestingOrderCount(orderId);

        o.active = false;
        o.payoutAmount = 0;

        emit OrderCancelled(orderId);
    }

    function _attemptMatch(uint256 takerOrderId) internal {
        Order storage taker = orders[takerOrderId];
        if (!_isOrderOpen(taker)) return;

        uint256[] storage ids = marketOrderIds[taker.marketKey];

        for (uint256 i = 0; i < ids.length && taker.payoutAmount > 0; i++) {
            uint256 makerId = ids[i];
            if (makerId == takerOrderId) continue;

            Order storage maker = orders[makerId];
            if (!_isOrderOpen(maker)) continue;
            if (!_canMatch(maker.intent, taker.intent)) continue;
            if (maker.askPrice != taker.askPrice) continue;

            uint256 fill =
                maker.payoutAmount < taker.payoutAmount ? maker.payoutAmount : taker.payoutAmount;

            address paymentToken = address(0);

            (uint256 premiumAmount, uint256 totalFeeCharged) = _executeStoredTrade(
                maker,
                taker,
                fill,
                paymentToken
            );

            maker.payoutAmount -= fill;
            taker.payoutAmount -= fill;

            if (maker.payoutAmount == 0) {
                maker.active = false;
                _clearRestingOrderCount(maker.orderId);
            }

            if (taker.payoutAmount == 0) {
                taker.active = false;
                _clearRestingOrderCount(taker.orderId);
            }

            emit OrderMatched(
                maker.orderId,
                taker.orderId,
                taker.user,
                fill,
                premiumAmount,
                totalFeeCharged
            );
        }
    }

    function _executeStoredTrade(
        Order storage maker,
        Order storage taker,
        uint256 payoutAmount,
        address paymentToken
    ) internal returns (uint256 premiumAmount, uint256 totalFeeCharged) {
        premiumAmount = (payoutAmount * maker.askPrice) / WAD;

        if (maker.intent == OrderIntent.BUY_OPTION && taker.intent == OrderIntent.SELL_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(maker, maker.user, payoutAmount);
            maker.premiumSpent += premiumAmount;

            _transferTokenOrETH(
                maker.user,
                taker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            _consumeHolderReservation(taker.marketKey, taker.user, payoutAmount);
            marginOptionContract.transferHolderPosition(
                taker.marketKey,
                taker.user,
                maker.user,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.BUY_OPTION && taker.intent == OrderIntent.WRITE_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(maker, maker.user, payoutAmount);
            maker.premiumSpent += premiumAmount;

            _transferTokenOrETH(
                maker.user,
                taker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            marginOptionContract.registerNewPosition(
                taker.marketKey,
                taker.user,
                maker.user,
                payoutAmount,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.SELL_OPTION && taker.intent == OrderIntent.BUY_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(taker, taker.user, payoutAmount);
            taker.premiumSpent += premiumAmount;

            _transferTokenOrETH(
                taker.user,
                maker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            _consumeHolderReservation(maker.marketKey, maker.user, payoutAmount);
            marginOptionContract.transferHolderPosition(
                maker.marketKey,
                maker.user,
                taker.user,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.WRITE_OPTION && taker.intent == OrderIntent.BUY_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(taker, taker.user, payoutAmount);
            taker.premiumSpent += premiumAmount;

            _transferTokenOrETH(
                taker.user,
                maker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            marginOptionContract.registerNewPosition(
                maker.marketKey,
                maker.user,
                taker.user,
                payoutAmount,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        revert UnmatchableIntents();
    }

    function _executeTrade(
        Order storage maker,
        Order memory taker,
        uint256 payoutAmount,
        address paymentToken,
        address takerFeeToken
    ) internal returns (uint256 premiumAmount, uint256 totalFeeCharged) {
        premiumAmount = (payoutAmount * maker.askPrice) / WAD;

        if (maker.intent == OrderIntent.BUY_OPTION && taker.intent == OrderIntent.SELL_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(maker, maker.user, payoutAmount);
            maker.premiumSpent += premiumAmount;

            // buyer pays seller for existing holder exposure
            _transferTokenOrETH(
                maker.user,
                taker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            _consumeHolderReservation(taker.marketKey, taker.user, payoutAmount);
            marginOptionContract.transferHolderPosition(
                taker.marketKey,
                taker.user,
                maker.user,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.BUY_OPTION && taker.intent == OrderIntent.WRITE_OPTION) {
            totalFeeCharged = _chargeStoredBuyFeesForFill(maker, maker.user, payoutAmount);
            maker.premiumSpent += premiumAmount;

            // buyer pays writer; fresh exposure created
            _transferTokenOrETH(
                maker.user,
                taker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            marginOptionContract.registerNewPosition(
                taker.marketKey,
                taker.user,
                maker.user,
                payoutAmount,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.SELL_OPTION && taker.intent == OrderIntent.BUY_OPTION) {
            totalFeeCharged = _chargeImmediateBuyFees(
                taker.user,
                takerFeeToken,
                paymentToken,
                premiumAmount
            );

            _transferTokenOrETH(
                taker.user,
                maker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            _consumeHolderReservation(maker.marketKey, maker.user, payoutAmount);
            marginOptionContract.transferHolderPosition(
                maker.marketKey,
                maker.user,
                taker.user,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        if (maker.intent == OrderIntent.WRITE_OPTION && taker.intent == OrderIntent.BUY_OPTION) {
            totalFeeCharged = _chargeImmediateBuyFees(
                taker.user,
                takerFeeToken,
                paymentToken,
                premiumAmount
            );

            _transferTokenOrETH(
                taker.user,
                maker.user,
                paymentToken,
                premiumAmount,
                "binary_option_premium"
            );
            marginOptionContract.registerNewPosition(
                maker.marketKey,
                maker.user,
                taker.user,
                payoutAmount,
                payoutAmount
            );
            return (premiumAmount, totalFeeCharged);
        }

        revert UnmatchableIntents();
    }

    function _routeAcceptIntent(
        bytes32 marketKey,
        OrderIntent makerIntent,
        address takerUser,
        uint256 payoutAmount
    ) internal view returns (OrderIntent) {
        if (makerIntent == OrderIntent.BUY_OPTION) {
            uint256 claimable = marginOptionContract.getHolderClaimablePayout(marketKey, takerUser);
            uint256 reserved = reservedHolderPayout[marketKey][takerUser];
            uint256 available = claimable > reserved ? (claimable - reserved) : 0;

            if (available >= payoutAmount) {
                return OrderIntent.SELL_OPTION;
            }

            return OrderIntent.WRITE_OPTION;
        }

        if (makerIntent == OrderIntent.SELL_OPTION || makerIntent == OrderIntent.WRITE_OPTION) {
            return OrderIntent.BUY_OPTION;
        }

        revert UnsupportedMakerIntent();
    }

    function _reserveForOrder(Order storage o, address paymentToken) internal {
        if (o.intent == OrderIntent.BUY_OPTION) {
            uint256 premiumAmount = _premium(o.payoutAmount, o.askPrice);
            _lockTokenOrETH(o.user, paymentToken, premiumAmount);

            FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
                o.feeToken,
                paymentToken,
                premiumAmount,
                FEE_CONTEXT_BINARY_OPTIONS,
                o.user,
                false
            );

            o.fixedFeeToken = f.fixedToken;
            o.fixedFeeTotal = f.fixedAmount;
            o.fixedFeeCharged = false;
            o.pctFeeToken = f.percentageToken;
            o.pctFeeTotal = f.percentageAmount;
            o.pctFeeCharged = 0;
            o.premiumLocked = premiumAmount;
            o.premiumSpent = 0;

            if (o.fixedFeeTotal > 0) _lockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
            if (o.pctFeeTotal > 0) _lockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal);
            return;
        }

        if (o.intent == OrderIntent.WRITE_OPTION) {
            _lockTokenOrETH(o.user, paymentToken, o.payoutAmount);
            return;
        }

        if (o.intent == OrderIntent.SELL_OPTION) {
            _reserveHolderPayout(o.marketKey, o.user, o.payoutAmount);
            return;
        }

        revert UnsupportedIntent();
    }

    function _reserveForAccept(Order memory taker, address paymentToken) internal {
        if (taker.intent == OrderIntent.BUY_OPTION) {
            uint256 premiumAmount = _premium(taker.payoutAmount, taker.askPrice);
            _lockTokenOrETH(taker.user, paymentToken, premiumAmount);

            FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
                taker.feeToken,
                paymentToken,
                premiumAmount,
                FEE_CONTEXT_BINARY_OPTIONS,
                taker.user,
                false
            );

            if (f.fixedAmount > 0) _lockTokenOrETH(taker.user, f.fixedToken, f.fixedAmount);
            if (f.percentageAmount > 0) {
                _lockTokenOrETH(taker.user, f.percentageToken, f.percentageAmount);
            }
            return;
        }

        if (taker.intent == OrderIntent.WRITE_OPTION) {
            _lockTokenOrETH(taker.user, paymentToken, taker.payoutAmount);
            return;
        }

        if (taker.intent == OrderIntent.SELL_OPTION) {
            _reserveHolderPayout(taker.marketKey, taker.user, taker.payoutAmount);
            return;
        }

        revert UnsupportedIntent();
    }

    function _resnapshotUnfilledBuyFeesAsMaker(Order storage o, address paymentToken) internal {
        if (o.intent != OrderIntent.BUY_OPTION || !o.active) return;
        if (o.payoutAmount == 0 || o.payoutAmount != o.originalPayoutAmount) return;

        if (!o.fixedFeeCharged && o.fixedFeeTotal > 0) {
            _unlockTokenOrETH(o.user, o.fixedFeeToken, o.fixedFeeTotal);
        }
        if (o.pctFeeTotal > o.pctFeeCharged) {
            _unlockTokenOrETH(o.user, o.pctFeeToken, o.pctFeeTotal - o.pctFeeCharged);
        }

        uint256 premiumAmount = _premium(o.payoutAmount, o.askPrice);
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            o.feeToken,
            paymentToken,
            premiumAmount,
            FEE_CONTEXT_BINARY_OPTIONS,
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

    function _releaseForOrder(Order storage order, address paymentToken) internal {
        uint256 payoutAmount = order.payoutAmount;
        if (payoutAmount == 0) return;

        if (order.intent == OrderIntent.BUY_OPTION) {
            uint256 premiumRemain =
                order.premiumLocked > order.premiumSpent
                    ? (order.premiumLocked - order.premiumSpent)
                    : 0;

            if (premiumRemain > 0) {
                _unlockTokenOrETH(order.user, paymentToken, premiumRemain);
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

        if (order.intent == OrderIntent.WRITE_OPTION) {
            _unlockTokenOrETH(order.user, paymentToken, payoutAmount);
            return;
        }

        if (order.intent == OrderIntent.SELL_OPTION) {
            uint256 reserved = reservedHolderPayout[order.marketKey][order.user];
            if (reserved < payoutAmount) revert BadHolderRelease();
            reservedHolderPayout[order.marketKey][order.user] = reserved - payoutAmount;
            return;
        }

        revert UnsupportedIntent();
    }

    function _chargeImmediateBuyFees(
        address premiumPayer,
        address feeToken,
        address paymentToken,
        uint256 premiumAmount
    ) internal returns (uint256 chargedThisStep) {
        FeeManager.FeeOutput memory f = feeManager.getFeeForAccount(
            feeToken,
            paymentToken,
            premiumAmount,
            FEE_CONTEXT_BINARY_OPTIONS,
            premiumPayer,
            false
        );

        if (f.fixedAmount > 0) {
            vault.chargeFee(
                premiumPayer,
                f.fixedToken,
                f.fixedAmount,
                "binary_option_trade_fee_fixed",
                true
            );
            chargedThisStep += f.fixedAmount;
        }

        if (f.percentageAmount > 0) {
            vault.chargeFee(
                premiumPayer,
                f.percentageToken,
                f.percentageAmount,
                "binary_option_trade_fee_pct",
                false
            );
            chargedThisStep += f.percentageAmount;
        }
    }

    function _chargeStoredBuyFeesForFill(
        Order storage feeOrder,
        address premiumPayer,
        uint256 fillPayoutAmount
    ) internal returns (uint256 chargedThisStep) {
        if (feeOrder.intent != OrderIntent.BUY_OPTION) return 0;

        if (!feeOrder.fixedFeeCharged) {
            if (feeOrder.fixedFeeTotal > 0) {
                vault.chargeFee(
                    premiumPayer,
                    feeOrder.fixedFeeToken,
                    feeOrder.fixedFeeTotal,
                    "binary_option_trade_fee_fixed",
                    true
                );
                chargedThisStep += feeOrder.fixedFeeTotal;
            }
            feeOrder.fixedFeeCharged = true;
        }

        if (feeOrder.pctFeeTotal == 0) return chargedThisStep;

        uint256 filledBefore = feeOrder.originalPayoutAmount - feeOrder.payoutAmount;
        uint256 filledAfter = filledBefore + fillPayoutAmount;

        if (filledAfter >= feeOrder.originalPayoutAmount) {
            uint256 remainder = feeOrder.pctFeeTotal - feeOrder.pctFeeCharged;
            if (remainder > 0) {
                vault.chargeFee(
                    premiumPayer,
                    feeOrder.pctFeeToken,
                    remainder,
                    "binary_option_trade_fee_pct",
                    false
                );
                feeOrder.pctFeeCharged = feeOrder.pctFeeTotal;
                chargedThisStep += remainder;
            }
            return chargedThisStep;
        }

        uint256 pctTargetAfter =
            (feeOrder.pctFeeTotal * filledAfter) / feeOrder.originalPayoutAmount;

        if (pctTargetAfter > feeOrder.pctFeeCharged) {
            uint256 delta = pctTargetAfter - feeOrder.pctFeeCharged;
            vault.chargeFee(
                premiumPayer,
                feeOrder.pctFeeToken,
                delta,
                "binary_option_trade_fee_pct",
                false
            );
            feeOrder.pctFeeCharged = pctTargetAfter;
            chargedThisStep += delta;
        }
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

        Order storage o = orders[orderId];

        isOrderInBook[orderId] = true;
        unmatchedOrderCount[o.user][o.marketKey]++;
    }

    function _clearRestingOrderCount(uint256 orderId) internal {
        if (!isOrderInBook[orderId]) return;

        Order storage o = orders[orderId];

        isOrderInBook[orderId] = false;

        if (unmatchedOrderCount[o.user][o.marketKey] > 0) {
            unmatchedOrderCount[o.user][o.marketKey]--;
        }
    }

    function _reserveHolderPayout(bytes32 marketKey, address user, uint256 payoutAmount) internal {
        uint256 claimable = marginOptionContract.getHolderClaimablePayout(marketKey, user);
        uint256 reserved = reservedHolderPayout[marketKey][user];
        uint256 available = claimable > reserved ? (claimable - reserved) : 0;

        if (available < payoutAmount) revert InsufficientHolderPayout();
        reservedHolderPayout[marketKey][user] += payoutAmount;
    }

    function _consumeHolderReservation(
        bytes32 marketKey,
        address user,
        uint256 payoutAmount
    ) internal {
        uint256 reserved = reservedHolderPayout[marketKey][user];
        if (reserved < payoutAmount) revert BadHolderReservation();
        reservedHolderPayout[marketKey][user] = reserved - payoutAmount;
    }

    function _premium(uint256 payoutAmount, uint256 askPrice) internal pure returns (uint256) {
        return (payoutAmount * askPrice) / WAD;
    }

    function _isOrderOpen(Order storage o) internal view returns (bool) {
        if (!o.active) return false;
        if (o.user == address(0)) return false;
        if (o.payoutAmount == 0) return false;
        if (o.expiry != 0 && block.timestamp > o.expiry) return false;
        return true;
    }

    function _isBidIntent(OrderIntent intent) internal pure returns (bool) {
        return intent == OrderIntent.BUY_OPTION;
    }

    function _canMatch(OrderIntent maker, OrderIntent taker) internal pure returns (bool) {
        if (maker == OrderIntent.BUY_OPTION) {
            return taker == OrderIntent.SELL_OPTION || taker == OrderIntent.WRITE_OPTION;
        }
        if (taker == OrderIntent.BUY_OPTION) {
            return maker == OrderIntent.SELL_OPTION || maker == OrderIntent.WRITE_OPTION;
        }
        return false;
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
        if (token == address(0)) vault.transferETH(from, to, amount, reason);
        else vault.transferToken(from, to, token, amount, reason);
    }
}
