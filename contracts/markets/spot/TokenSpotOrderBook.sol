// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";

contract TokenSpotOrderBook is AccessControl {
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;

    error ZeroAddress();
    error Unauthorized();
    error InvalidAccount();
    error InvalidPair();
    error InvalidToken();
    error InvalidOrder();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidExpiry();
    error OrderDoesNotExist();
    error OrderExpired();
    error NotOrderOwner();
    error MaxUnmatchedOrdersReached();
    error TooManyOrdersThisBlock();
    error IndexOutOfRange();
    error PriceNotMatchable();
    error CrossPriceNotMatchable();
    error BadCrossPrice();
    error NoCrossLiquidity();
    error TradeAmountIsZero();
    error TotalQuoteIsZero();
    error SpentExceedsLockedOffer();
    error MakerSpentExceedsLocked();
    error MakerCrossSpentExceedsLocked();
    error CrossFillTooSmall();
    error CrossDeltaExceedsMaker();
    error InvalidOrderLimits();

    SethxVault public vault;
    FeeManager public feeManager;
    AccountRegistry public accountRegistry;

    enum Side {
        Bid,
        Ask
    }

    enum MatchType {
        None,
        NormalBook,
        CrossBook
    }

    struct Order {
        uint256 orderId;
        address user;
        address referrer;
        address baseToken;
        address quoteToken;
        Side side;
        uint256 price; // 1e18 quote per 1 base
        uint256 amount; // remaining BASE amount (baseToken units)
        uint256 initialAmount; // original BASE amount (baseToken units)
        uint256 expiry; // user may pass 0 => default expiry applied on placement
        // ---- Fee snapshot budgets ----
        uint256 fixedFeeAmount;
        address fixedFeeToken;
        uint256 percentageFeeAmount;
        address percentageFeeToken;
        // ---- Fee progress ----
        bool fixedFeeCharged;
        uint256 percentageFeeCharged; // cumulative charged so far
        // ---- linked list ----
        uint256 prev;
        uint256 next;
        // ---- user order tracking ----
        uint256 offeredLocked; // initial locked amount of offered token
        uint256 offeredSpent; // cumulative spent from offeredLocked
        uint256 userIndex;
    }

    struct IncomingOrderMatchState {
        uint256 remaining;
    }

    struct OrderBookSide {
        uint256 head;
        uint256 tail;
    }

    string private constant FEE_CONTEXT = "ERC20 Spot Trade";

    uint256 private constant ONE = 1e18;
    uint256 private constant INVERSE_SCALE = 1e36;

    uint256 public maxUnmatchedOrders;
    uint256 public maxOrdersPerBlock;

    uint256 public nextOrderId = 1;

    mapping(uint256 => Order) public orders;
    mapping(address => mapping(address => mapping(Side => OrderBookSide))) internal marketBooks;

    mapping(address => uint256[]) internal userOrders;
    mapping(address => uint256[]) internal userOrderFreeSlots;

    mapping(address => mapping(address => mapping(address => uint256))) public unmatchedOrderCount;
    mapping(address => mapping(address => mapping(address => uint256))) public lastOrderBlock;
    mapping(address => mapping(address => mapping(address => uint256))) public ordersInBlock;

    struct BookKey {
        address baseToken;
        address quoteToken;
    }

    BookKey[] internal activeBooks;
    mapping(bytes32 => bool) public isActiveBook;
    mapping(bytes32 => uint256) internal activeBookIndexPlus1; // 1-based
    mapping(bytes32 => uint256) internal activeBookOrderCount;

    event OrderPlaced(uint256 indexed orderId, address indexed user, address indexed referrer);

    event OrderMatched(
        uint256 indexed makerOrderId,
        uint256 indexed takerOrderId,
        address indexed takerUser,
        uint256 baseAmount
    );
    event OrderCancelled(uint256 indexed orderId);
    event RateLimitHit(
        address indexed user,
        address baseToken,
        address quoteToken,
        uint256 blockNumber
    );
    event ActiveBookChanged(address indexed baseToken, address indexed quoteToken, bool active);

    event OrderLimitsSet(uint256 maxOrdersPerBlock, uint256 maxUnmatchedOrders);

    modifier onlyAdmin() {
        if (!hasRole(ADMIN_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }

        _;
    }

    constructor(address _vault, address _feeManager, address _accountRegistry, address _admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_feeManager == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        feeManager = FeeManager(_feeManager);
        accountRegistry = AccountRegistry(_accountRegistry);

        maxOrdersPerBlock = 20;
        maxUnmatchedOrders = 100;

        emit OrderLimitsSet(20, 100);

        _grantRole(ADMIN_ROLE, _admin);
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

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getOrderBook(
        address baseToken,
        address quoteToken
    ) external view returns (uint256[] memory bids, uint256[] memory asks) {
        bids = _collectOrderIds(marketBooks[baseToken][quoteToken][Side.Bid]);
        asks = _collectOrderIds(marketBooks[baseToken][quoteToken][Side.Ask]);
    }

    function getActiveBookCount() external view returns (uint256) {
        return activeBooks.length;
    }

    function getActiveBookAt(
        uint256 index
    ) external view returns (address baseToken, address quoteToken) {
        if (index >= activeBooks.length) revert IndexOutOfRange();
        BookKey memory b = activeBooks[index];
        return (b.baseToken, b.quoteToken);
    }

    function getActiveBooks()
        external
        view
        returns (address[] memory bases, address[] memory quotes)
    {
        uint256 n = activeBooks.length;
        bases = new address[](n);
        quotes = new address[](n);

        for (uint256 i = 0; i < n; i++) {
            bases[i] = activeBooks[i].baseToken;
            quotes[i] = activeBooks[i].quoteToken;
        }
    }

    function getActiveBooksPaged(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory bases, address[] memory quotes) {
        uint256 n = activeBooks.length;

        if (offset >= n) {
            bases = new address[](0);
            quotes = new address[](0);
            return (bases, quotes);
        }

        uint256 end = offset + limit;
        if (end > n) end = n;

        uint256 size = end - offset;
        bases = new address[](size);
        quotes = new address[](size);

        for (uint256 i = 0; i < size; i++) {
            BookKey memory b = activeBooks[offset + i];
            bases[i] = b.baseToken;
            quotes[i] = b.quoteToken;
        }

        return (bases, quotes);
    }

    function getActiveBookOrderCount(
        address baseToken,
        address quoteToken
    ) external view returns (uint256) {
        return activeBookOrderCount[_bookHash(baseToken, quoteToken)];
    }

    function getActiveBookOrderIds(
        uint256 index
    ) external view returns (uint256[] memory bids, uint256[] memory asks) {
        if (index >= activeBooks.length) revert IndexOutOfRange();
        BookKey memory b = activeBooks[index];

        bids = _collectOrderIds(marketBooks[b.baseToken][b.quoteToken][Side.Bid]);
        asks = _collectOrderIds(marketBooks[b.baseToken][b.quoteToken][Side.Ask]);
    }

    function placeOrder(
        address feeToken,
        address baseToken,
        address quoteToken,
        Side side,
        uint256 price,
        uint256 amount,
        uint256 expiry,
        address referrer
    ) external onlyAccount returns (uint256) {
        if (baseToken == quoteToken) revert InvalidPair();
        if (amount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        if (!_isERC20(baseToken) || !_isERC20(quoteToken)) revert InvalidToken();

        if (unmatchedOrderCount[msg.sender][baseToken][quoteToken] >= maxUnmatchedOrders) {
            revert MaxUnmatchedOrdersReached();
        }

        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry();

        if (block.number != lastOrderBlock[msg.sender][baseToken][quoteToken]) {
            ordersInBlock[msg.sender][baseToken][quoteToken] = 0;
            lastOrderBlock[msg.sender][baseToken][quoteToken] = block.number;
        }

        if (ordersInBlock[msg.sender][baseToken][quoteToken] >= maxOrdersPerBlock) {
            emit RateLimitHit(msg.sender, baseToken, quoteToken, block.number);
            revert TooManyOrdersThisBlock();
        }

        ordersInBlock[msg.sender][baseToken][quoteToken]++;

        (address offeredToken, uint256 offeredAmount) = _offeredFor(
            side,
            baseToken,
            quoteToken,
            price,
            amount
        );

        _lockAsset(msg.sender, offeredToken, offeredAmount);

        FeeManager.FeeOutput memory fee = _lockFees(
            msg.sender,
            feeToken,
            offeredToken,
            offeredAmount,
            false
        );

        uint256 orderId = nextOrderId++;

        Order storage taker = orders[orderId];

        taker.orderId = orderId;
        taker.user = msg.sender;
        taker.referrer = referrer;
        taker.baseToken = baseToken;
        taker.quoteToken = quoteToken;
        taker.side = side;
        taker.price = price;
        taker.amount = amount;
        taker.initialAmount = amount;
        taker.expiry = expiry;

        taker.fixedFeeAmount = fee.fixedAmount;
        taker.fixedFeeToken = fee.fixedToken;
        taker.percentageFeeAmount = fee.percentageAmount;
        taker.percentageFeeToken = fee.percentageToken;
        taker.fixedFeeCharged = false;
        taker.percentageFeeCharged = 0;

        taker.prev = 0;
        taker.next = 0;
        taker.offeredLocked = offeredAmount;
        taker.offeredSpent = 0;
        taker.userIndex = 0;

        IncomingOrderMatchState memory matchState = _matchIncomingOrder(orderId);

        uint256 remaining = matchState.remaining;

        if (remaining > 0) {
            if (remaining == amount) {
                _unlockRemainingFeeBudgets(taker);

                FeeManager.FeeOutput memory makerFee = _lockFees(
                    msg.sender,
                    feeToken,
                    offeredToken,
                    offeredAmount,
                    true
                );

                taker.fixedFeeAmount = makerFee.fixedAmount;
                taker.fixedFeeToken = makerFee.fixedToken;
                taker.percentageFeeAmount = makerFee.percentageAmount;
                taker.percentageFeeToken = makerFee.percentageToken;
                taker.fixedFeeCharged = false;
                taker.percentageFeeCharged = 0;
            }

            taker.amount = remaining;

            _insertOrder(marketBooks[baseToken][quoteToken][side], orderId);

            emit OrderPlaced(orderId, msg.sender, referrer);
            return orderId;
        }

        _finalizeFilledOrder(orderId);
        return 0;
    }

    function _finalizeFilledOrder(uint256 orderId) internal {
        Order storage o = orders[orderId];
        if (o.user == address(0)) return;

        _unlockRemainingOffered(o);
        _unlockRemainingFeeBudgets(o);

        delete orders[orderId];
    }

    function _matchIncomingOrder(
        uint256 takerOrderId
    ) internal returns (IncomingOrderMatchState memory state) {
        Order storage taker = orders[takerOrderId];
        state.remaining = taker.amount;

        OrderBookSide storage opposingBook = marketBooks[taker.baseToken][taker.quoteToken][
            taker.side == Side.Bid ? Side.Ask : Side.Bid
        ];

        OrderBookSide storage crossBook = marketBooks[taker.quoteToken][taker.baseToken][
            taker.side
        ];

        uint256 opposingId = opposingBook.head;
        uint256 crossId = crossBook.head;

        while (state.remaining > 0 && (opposingId != 0 || crossId != 0)) {
            while (opposingId != 0) {
                Order storage o = orders[opposingId];

                if (_isExpired(o) || o.amount == 0) {
                    uint256 next = o.next;
                    _cancelAndRemoveExpired(opposingBook, opposingId);
                    opposingId = next;
                } else {
                    break;
                }
            }

            while (crossId != 0) {
                Order storage o = orders[crossId];

                if (_isExpired(o) || o.amount == 0) {
                    uint256 next = o.next;
                    _cancelAndRemoveExpired(crossBook, crossId);
                    crossId = next;
                } else {
                    break;
                }
            }

            if (opposingId == 0 && crossId == 0) {
                break;
            }

            MatchType mt = _selectBestMatch(opposingId, crossId, taker);

            if (mt == MatchType.None) {
                break;
            }

            taker.amount = state.remaining;

            if (mt == MatchType.NormalBook) {
                Order storage maker = orders[opposingId];
                uint256 next = maker.next;

                (uint256 traded, uint256 spentOffered) = _matchNormal(maker, taker);

                taker.offeredSpent += spentOffered;

                if (taker.offeredSpent > taker.offeredLocked) {
                    revert SpentExceedsLockedOffer();
                }

                state.remaining = taker.amount;

                maker.amount -= traded;

                if (maker.amount == 0) {
                    _removeOrder(opposingBook, maker.orderId);
                }

                opposingId = next;
            } else {
                Order storage makerCross = orders[crossId];
                uint256 next = makerCross.next;

                (, uint256 spentOffered) = _matchCross(makerCross, taker);

                taker.offeredSpent += spentOffered;

                if (taker.offeredSpent > taker.offeredLocked) {
                    revert SpentExceedsLockedOffer();
                }

                state.remaining = taker.amount;

                crossId = next;
            }
        }
    }

    function acceptOrder(
        uint256 makerOrderId,
        uint256 amount,
        address feeToken,
        address referrer
    ) external onlyAccount {
        Order storage maker = orders[makerOrderId];
        if (maker.user == address(0)) revert OrderDoesNotExist();
        if (_isExpired(maker)) revert OrderExpired();
        if (amount == 0 || amount > maker.amount) revert InvalidAmount();

        Side takerSide = maker.side == Side.Bid ? Side.Ask : Side.Bid;

        uint256 totalQuote = (amount * maker.price) / ONE;
        if (totalQuote == 0) revert TotalQuoteIsZero();

        (address offeredToken, uint256 offeredAmount) = _offeredFor(
            takerSide,
            maker.baseToken,
            maker.quoteToken,
            maker.price,
            amount
        );

        _lockAsset(msg.sender, offeredToken, offeredAmount);
        uint256 offeredLocked = offeredAmount;

        FeeManager.FeeOutput memory fee = _lockFees(
            msg.sender,
            feeToken,
            offeredToken,
            offeredAmount,
            false
        );

        uint256 takerOrderId = nextOrderId++;

        Order storage taker = orders[takerOrderId];

        taker.orderId = takerOrderId;
        taker.user = msg.sender;
        taker.referrer = referrer;
        taker.baseToken = maker.baseToken;
        taker.quoteToken = maker.quoteToken;
        taker.side = takerSide;
        taker.price = maker.price;
        taker.amount = amount;
        taker.initialAmount = amount;
        taker.expiry = block.timestamp + 1;

        taker.fixedFeeAmount = fee.fixedAmount;
        taker.fixedFeeToken = fee.fixedToken;
        taker.percentageFeeAmount = fee.percentageAmount;
        taker.percentageFeeToken = fee.percentageToken;
        taker.fixedFeeCharged = false;
        taker.percentageFeeCharged = 0;

        taker.prev = 0;
        taker.next = 0;
        taker.offeredLocked = offeredLocked;
        taker.offeredSpent = 0;
        taker.userIndex = 0;

        _executeTradeAndFeesNormal(maker, taker, amount, maker.price);

        uint256 spentOffered;
        if (takerSide == Side.Bid) {
            spentOffered = (amount * maker.price) / ONE;
        } else {
            spentOffered = amount;
        }

        taker.offeredSpent = spentOffered;

        maker.amount -= amount;
        if (maker.amount == 0) {
            _removeOrder(marketBooks[maker.baseToken][maker.quoteToken][maker.side], makerOrderId);
        }

        _finalizeFilledOrder(takerOrderId);
    }

    function cancelOrder(uint256 orderId) external onlyAccount {
        Order storage o = orders[orderId];
        if (o.user == address(0)) revert OrderDoesNotExist();
        if (o.user != msg.sender) revert NotOrderOwner();

        _unlockRemainingOffered(o);
        _unlockRemainingFeeBudgets(o);

        _removeOrder(marketBooks[o.baseToken][o.quoteToken][o.side], orderId);

        emit OrderCancelled(orderId);
    }

    function sweepExpiredOrders(
        address baseToken,
        address quoteToken,
        Side side,
        uint256 limit
    ) external onlyAdmin {
        OrderBookSide storage book = marketBooks[baseToken][quoteToken][side];
        uint256 current = book.head;
        uint256 cleaned = 0;

        while (current != 0 && cleaned < limit) {
            Order storage o = orders[current];
            uint256 next = o.next;

            if (_isExpired(o)) {
                _unlockRemainingOffered(o);
                _unlockRemainingFeeBudgets(o);
                _removeOrder(book, current);
                cleaned++;
            }

            current = next;
        }
    }

    function _matchNormal(
        Order storage maker,
        Order storage taker
    ) internal returns (uint256 tradedBase, uint256 spentOffered) {
        if (taker.side == Side.Bid) {
            if (taker.price < maker.price) revert PriceNotMatchable();
        } else {
            if (taker.price > maker.price) revert PriceNotMatchable();
        }

        tradedBase = taker.amount < maker.amount ? taker.amount : maker.amount;
        if (tradedBase == 0) revert TradeAmountIsZero();

        _executeTradeAndFeesNormal(maker, taker, tradedBase, maker.price);

        taker.amount -= tradedBase;

        if (taker.side == Side.Bid) {
            spentOffered = (tradedBase * maker.price) / ONE;
        } else {
            spentOffered = tradedBase;
        }
    }

    function _executeTradeAndFeesNormal(
        Order storage maker,
        Order storage taker,
        uint256 baseAmount,
        uint256 execPrice
    ) internal {
        uint256 totalQuote = (baseAmount * execPrice) / ONE;
        if (totalQuote == 0) revert TotalQuoteIsZero();

        if (maker.side == Side.Bid) {
            maker.offeredSpent += totalQuote;
            if (maker.offeredSpent > maker.offeredLocked) {
                revert MakerSpentExceedsLocked();
            }
        } else {
            maker.offeredSpent += baseAmount;
            if (maker.offeredSpent > maker.offeredLocked) {
                revert MakerSpentExceedsLocked();
            }
        }

        address buyer = maker.side == Side.Bid ? maker.user : taker.user;
        address seller = maker.side == Side.Bid ? taker.user : maker.user;

        _transferAsset(seller, buyer, maker.baseToken, baseAmount, "Spot Trade");
        _transferAsset(buyer, seller, maker.quoteToken, totalQuote, "Spot Trade");

        _chargeFixedIfNeededStorage(maker);
        _chargePctProRataStorage(maker, baseAmount);

        _chargeFixedIfNeededStorage(taker);
        _chargePctProRataStorage(taker, baseAmount);

        emit OrderMatched(maker.orderId, taker.orderId, taker.user, baseAmount);
    }

    function _matchCross(
        Order storage makerCross,
        Order storage taker
    ) internal returns (uint256 tradedBase, uint256 spentOffered) {
        uint256 invPrice = INVERSE_SCALE / makerCross.price;
        if (invPrice == 0) revert BadCrossPrice();

        if (taker.side == Side.Bid) {
            if (taker.price < invPrice) revert CrossPriceNotMatchable();
        } else {
            if (taker.price > invPrice) revert CrossPriceNotMatchable();
        }

        uint256 effectiveBaseAvail = (makerCross.amount * makerCross.price) / ONE;
        if (effectiveBaseAvail == 0) revert NoCrossLiquidity();

        tradedBase = taker.amount < effectiveBaseAvail ? taker.amount : effectiveBaseAvail;
        if (tradedBase == 0) revert TradeAmountIsZero();

        uint256 makerCrossBaseDelta = (tradedBase * ONE) / makerCross.price;
        if (makerCrossBaseDelta == 0) {
            revert CrossFillTooSmall();
        }

        if (makerCrossBaseDelta > makerCross.amount) {
            revert CrossDeltaExceedsMaker();
        }

        uint256 makerCrossSpent;
        if (makerCross.side == Side.Ask) {
            makerCrossSpent = makerCrossBaseDelta;
        } else {
            makerCrossSpent = (makerCrossBaseDelta * makerCross.price) / ONE;
        }

        makerCross.offeredSpent += makerCrossSpent;
        if (makerCross.offeredSpent > makerCross.offeredLocked) {
            revert MakerCrossSpentExceedsLocked();
        }

        _executeTradeAndFeesCross(makerCross, taker, tradedBase, invPrice, makerCrossBaseDelta);

        makerCross.amount -= makerCrossBaseDelta;
        taker.amount -= tradedBase;

        if (taker.side == Side.Bid) {
            spentOffered = (tradedBase * invPrice) / ONE;
        } else {
            spentOffered = tradedBase;
        }

        if (makerCross.amount == 0) {
            _removeOrder(
                marketBooks[makerCross.baseToken][makerCross.quoteToken][makerCross.side],
                makerCross.orderId
            );
        }
    }

    function _executeTradeAndFeesCross(
        Order storage makerCross,
        Order storage taker,
        uint256 baseAmountInTakerMarket,
        uint256 execPriceInTakerMarket,
        uint256 makerCrossFilledUnits
    ) internal {
        uint256 totalQuote = (baseAmountInTakerMarket * execPriceInTakerMarket) / ONE;
        if (totalQuote == 0) revert TotalQuoteIsZero();

        Side makerEffSide = makerCross.side == Side.Bid ? Side.Ask : Side.Bid;

        address buyer = makerEffSide == Side.Bid ? makerCross.user : taker.user;
        address seller = makerEffSide == Side.Bid ? taker.user : makerCross.user;

        _transferAsset(seller, buyer, taker.baseToken, baseAmountInTakerMarket, "Spot Trade");
        _transferAsset(buyer, seller, taker.quoteToken, totalQuote, "Spot Trade");

        _chargeFixedIfNeededStorage(makerCross);
        _chargePctProRataStorageByUnits(
            makerCross,
            makerCrossFilledUnits,
            makerCross.initialAmount
        );

        _chargeFixedIfNeededStorage(taker);
        _chargePctProRataStorage(taker, baseAmountInTakerMarket);

        emit OrderMatched(makerCross.orderId, taker.orderId, taker.user, baseAmountInTakerMarket);
    }

    function _chargeFixedIfNeededStorage(Order storage o) internal {
        if (!o.fixedFeeCharged) {
            o.fixedFeeCharged = true;
            if (o.fixedFeeAmount > 0) {
                vault.chargeFee(o.user, o.fixedFeeToken, o.fixedFeeAmount, FEE_CONTEXT, o.referrer);
            }
        }
    }

    function _chargePctProRataStorage(Order storage o, uint256 filledUnits) internal {
        _chargePctProRataStorageByUnits(o, filledUnits, o.initialAmount);
    }

    function _chargePctProRataStorageByUnits(
        Order storage o,
        uint256 filledThisStep,
        uint256 initialUnits
    ) internal {
        if (o.percentageFeeAmount == 0 || initialUnits == 0) return;

        uint256 remainingUnits = o.amount;
        uint256 filledBefore = initialUnits > remainingUnits ? (initialUnits - remainingUnits) : 0;
        uint256 filledAfter = filledBefore + filledThisStep;
        if (filledAfter > initialUnits) filledAfter = initialUnits;

        uint256 delta;
        if (filledAfter == initialUnits) {
            delta =
                o.percentageFeeAmount > o.percentageFeeCharged
                    ? (o.percentageFeeAmount - o.percentageFeeCharged)
                    : 0;
        } else {
            uint256 targetAfter = (o.percentageFeeAmount * filledAfter) / initialUnits;
            delta =
                targetAfter > o.percentageFeeCharged ? (targetAfter - o.percentageFeeCharged) : 0;
        }

        if (delta > 0) {
            vault.chargeFee(o.user, o.percentageFeeToken, delta, FEE_CONTEXT, o.referrer);
            o.percentageFeeCharged += delta;
        }
    }

    function _lockFees(
        address account,
        address feeToken,
        address offeredToken,
        uint256 offeredAmount,
        bool isMaker
    ) internal returns (FeeManager.FeeOutput memory fee) {
        fee = feeManager.getFeeForAccount(
            feeToken,
            offeredToken,
            offeredAmount,
            FEE_CONTEXT,
            account,
            isMaker
        );

        if (fee.fixedAmount > 0) {
            _lockAsset(account, fee.fixedToken, fee.fixedAmount);
        }
        if (fee.percentageAmount > 0) {
            _lockAsset(account, fee.percentageToken, fee.percentageAmount);
        }
    }

    function _unlockRemainingOffered(Order storage o) internal {
        uint256 rem = o.offeredLocked > o.offeredSpent ? (o.offeredLocked - o.offeredSpent) : 0;
        if (rem == 0) return;

        address offeredToken = (o.side == Side.Bid) ? o.quoteToken : o.baseToken;
        _unlockAsset(o.user, offeredToken, rem);

        o.offeredSpent = o.offeredLocked;
    }

    function _unlockRemainingFeeBudgets(Order storage o) internal {
        if (o.fixedFeeAmount > 0 && !o.fixedFeeCharged) {
            _unlockAsset(o.user, o.fixedFeeToken, o.fixedFeeAmount);
        }

        uint256 pctRemain =
            o.percentageFeeAmount > o.percentageFeeCharged
                ? (o.percentageFeeAmount - o.percentageFeeCharged)
                : 0;

        if (pctRemain > 0) {
            _unlockAsset(o.user, o.percentageFeeToken, pctRemain);
        }
    }

    function _insertOrder(OrderBookSide storage book, uint256 orderId) internal {
        Order storage newOrder = orders[orderId];

        _activateBookIfNeeded(newOrder.baseToken, newOrder.quoteToken);
        bytes32 h = _bookHash(newOrder.baseToken, newOrder.quoteToken);
        activeBookOrderCount[h] += 1;

        unmatchedOrderCount[newOrder.user][newOrder.baseToken][newOrder.quoteToken]++;

        uint256 userIndex;
        if (userOrderFreeSlots[newOrder.user].length > 0) {
            uint256 lastIdx = userOrderFreeSlots[newOrder.user].length - 1;
            userIndex = userOrderFreeSlots[newOrder.user][lastIdx];
            userOrderFreeSlots[newOrder.user].pop();
            userOrders[newOrder.user][userIndex] = orderId;
        } else {
            userIndex = userOrders[newOrder.user].length;
            userOrders[newOrder.user].push(orderId);
        }
        newOrder.userIndex = userIndex;

        uint256 current = book.head;

        if (current == 0) {
            book.head = orderId;
            book.tail = orderId;
            return;
        }

        while (current != 0) {
            Order storage existing = orders[current];

            bool betterPrice =
                newOrder.side == Side.Bid
                    ? newOrder.price > existing.price
                    : newOrder.price < existing.price;

            if (betterPrice) break;
            current = existing.next;
        }

        if (current == 0) {
            uint256 tailId = book.tail;
            orders[tailId].next = orderId;
            newOrder.prev = tailId;
            newOrder.next = 0;
            book.tail = orderId;
            return;
        }

        if (current == book.head) {
            newOrder.next = current;
            orders[current].prev = orderId;
            book.head = orderId;
            return;
        }

        uint256 prevId = orders[current].prev;
        orders[prevId].next = orderId;
        newOrder.prev = prevId;
        newOrder.next = current;
        orders[current].prev = orderId;
    }

    function _removeOrder(OrderBookSide storage book, uint256 orderId) internal {
        Order storage o = orders[orderId];
        if (o.user == address(0)) return;

        if (unmatchedOrderCount[o.user][o.baseToken][o.quoteToken] > 0) {
            unmatchedOrderCount[o.user][o.baseToken][o.quoteToken]--;
        }

        if (o.prev != 0) {
            orders[o.prev].next = o.next;
        } else {
            book.head = o.next;
        }

        if (o.next != 0) {
            orders[o.next].prev = o.prev;
        } else {
            book.tail = o.prev;
        }

        uint256 idx = o.userIndex;
        if (userOrders[o.user].length > idx && userOrders[o.user][idx] == orderId) {
            userOrders[o.user][idx] = 0;
            userOrderFreeSlots[o.user].push(idx);
        }

        bytes32 h = _bookHash(o.baseToken, o.quoteToken);
        if (activeBookOrderCount[h] > 0) {
            activeBookOrderCount[h] -= 1;
        }
        if (activeBookOrderCount[h] == 0) {
            _deactivateBookIfNeeded(o.baseToken, o.quoteToken);
        }

        delete orders[orderId];
    }

    function _cancelAndRemoveExpired(OrderBookSide storage book, uint256 orderId) internal {
        Order storage o = orders[orderId];
        if (o.user == address(0)) return;

        _unlockRemainingOffered(o);
        _unlockRemainingFeeBudgets(o);
        _removeOrder(book, orderId);
    }

    function _selectBestMatch(
        uint256 makerAId,
        uint256 makerBId,
        Order storage taker
    ) internal view returns (MatchType) {
        bool aValid = makerAId != 0 && !_isExpired(orders[makerAId]) && orders[makerAId].amount > 0;
        bool bValid = makerBId != 0 && !_isExpired(orders[makerBId]) && orders[makerBId].amount > 0;

        uint256 aPrice = aValid ? orders[makerAId].price : 0;
        uint256 bInvPrice = bValid ? (INVERSE_SCALE / orders[makerBId].price) : 0;

        bool aOk;
        bool bOk;

        if (taker.side == Side.Bid) {
            aOk = aValid && taker.price >= aPrice;
            bOk = bValid && taker.price >= bInvPrice;
        } else {
            aOk = aValid && taker.price <= aPrice;
            bOk = bValid && taker.price <= bInvPrice;
        }

        if (!aOk && !bOk) return MatchType.None;
        if (aOk && !bOk) return MatchType.NormalBook;
        if (!aOk && bOk) return MatchType.CrossBook;

        if (taker.side == Side.Bid) {
            return aPrice <= bInvPrice ? MatchType.NormalBook : MatchType.CrossBook;
        } else {
            return aPrice >= bInvPrice ? MatchType.NormalBook : MatchType.CrossBook;
        }
    }

    function _isExpired(Order storage o) internal view returns (bool) {
        return o.expiry != 0 && block.timestamp > o.expiry;
    }

    function _isERC20(address token) internal view returns (bool) {
        if (token == address(0)) return true;
        try IERC20(token).totalSupply() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _offeredFor(
        Side side,
        address baseToken,
        address quoteToken,
        uint256 price,
        uint256 baseAmount
    ) internal pure returns (address offeredToken, uint256 offeredAmount) {
        baseToken;
        if (side == Side.Bid) {
            offeredToken = quoteToken;
            offeredAmount = (baseAmount * price) / ONE;
        } else {
            offeredToken = baseToken;
            offeredAmount = baseAmount;
        }
    }

    function _collectOrderIds(
        OrderBookSide storage book
    ) internal view returns (uint256[] memory ids) {
        uint256 count = 0;
        uint256 current = book.head;

        while (current != 0) {
            count++;
            current = orders[current].next;
        }

        ids = new uint256[](count);
        current = book.head;

        for (uint256 i = 0; i < count; i++) {
            ids[i] = current;
            current = orders[current].next;
        }
    }

    function _lockAsset(address user, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.lockETH(user, amount);
        } else {
            vault.lockERC20(user, token, amount);
        }
    }

    function _unlockAsset(address user, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.unlockETH(user, amount);
        } else {
            vault.unlockERC20(user, token, amount);
        }
    }

    function _transferAsset(
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

    function _bookHash(address baseToken, address quoteToken) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    function _activateBookIfNeeded(address baseToken, address quoteToken) internal {
        bytes32 h = _bookHash(baseToken, quoteToken);
        if (!isActiveBook[h]) {
            isActiveBook[h] = true;
            activeBooks.push(BookKey({ baseToken: baseToken, quoteToken: quoteToken }));
            activeBookIndexPlus1[h] = activeBooks.length;
            emit ActiveBookChanged(baseToken, quoteToken, true);
        }
    }

    function _deactivateBookIfNeeded(address baseToken, address quoteToken) internal {
        bytes32 h = _bookHash(baseToken, quoteToken);
        if (!isActiveBook[h]) return;
        if (activeBookOrderCount[h] != 0) return;

        uint256 idxPlus1 = activeBookIndexPlus1[h];
        if (idxPlus1 == 0) return;

        uint256 idx = idxPlus1 - 1;
        uint256 last = activeBooks.length - 1;

        if (idx != last) {
            BookKey memory moved = activeBooks[last];
            activeBooks[idx] = moved;

            bytes32 movedHash = _bookHash(moved.baseToken, moved.quoteToken);
            activeBookIndexPlus1[movedHash] = idx + 1;
        }

        activeBooks.pop();
        isActiveBook[h] = false;
        activeBookIndexPlus1[h] = 0;

        emit ActiveBookChanged(baseToken, quoteToken, false);
    }
}
