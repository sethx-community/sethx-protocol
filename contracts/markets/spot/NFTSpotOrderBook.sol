// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { FeeManager } from "../../oracle/FeeManager.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @notice ERC721 NFT spot orderbook
 *
 * Design choices:
 * - Token-specific orderbook: market = (nft, tokenId, quoteToken)
 * - Order size is always 1 NFT
 * - No partial fills
 * - No cross-book matching
 * - Fee budget snapshotted at placement, like TokenSpotOrderBook
 *
 *  Seller ask:
 *  - locks ERC721 tokenId in vault
 *  - does not budget protocol trading fees
 *
 * Buyer bid:
 *   - locks quote token amount in vault
 *   - fee is budgeted from locked quote amount
 */
contract NFTSpotOrderBook is AccessControl {
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;

    error ZeroAddress();
    error Unauthorized();
    error InvalidAccount();
    error InvalidNft();
    error InvalidQuoteToken();
    error InvalidPrice();
    error InvalidExpiry();
    error InvalidToken();
    error OrderDoesNotExist();
    error OrderExpired();
    error NotOrderOwner();
    error MaxUnmatchedOrdersReached();
    error TooManyOrdersThisBlock();
    error IndexOutOfRange();
    error InvalidOrderLimits();

    enum Side {
        Bid,
        Ask
    }

    struct Order {
        uint256 orderId;
        address user;
        address nft;
        uint256 tokenId;
        address quoteToken;
        Side side;
        uint256 price; // quote token amount for 1 NFT
        uint256 expiry;
        // ---- fee snapshot budgets ----
        uint256 fixedFeeAmount;
        address fixedFeeToken;
        uint256 percentageFeeAmount;
        address percentageFeeToken;
        // ---- fee progress ----
        bool fixedFeeCharged;
        uint256 percentageFeeCharged;
        // ---- linked list ----
        uint256 prev;
        uint256 next;
        // ---- user order tracking ----
        uint256 userIndex;
    }

    struct OrderBookSide {
        uint256 head;
        uint256 tail;
    }

    struct MarketKey {
        address nft;
        uint256 tokenId;
        address quoteToken;
    }

    string private constant FEE_CONTEXT = "ERC721 Spot Trade";

    uint256 public maxUnmatchedOrders;
    uint256 public maxOrdersPerBlock;

    SethxVault public immutable vault;
    FeeManager public immutable feeManager;
    AccountRegistry public immutable accountRegistry;

    uint256 public nextOrderId = 1;

    mapping(uint256 => Order) public orders;

    // market => side => linked list
    mapping(address => mapping(uint256 => mapping(address => mapping(Side => OrderBookSide))))
        internal marketBooks;

    mapping(address => uint256[]) internal userOrders;
    mapping(address => uint256[]) internal userOrderFreeSlots;

    mapping(address => mapping(address => mapping(address => uint256))) public unmatchedOrderCount;
    mapping(address => mapping(address => mapping(address => uint256))) public lastOrderBlock;
    mapping(address => mapping(address => mapping(address => uint256))) public ordersInBlock;

    // active markets
    MarketKey[] internal activeMarkets;
    mapping(bytes32 => bool) public isActiveMarket;
    mapping(bytes32 => uint256) internal activeMarketIndexPlus1; // 1-based
    mapping(bytes32 => uint256) internal activeMarketOrderCount;

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        address indexed nft,
        uint256 tokenId,
        address quoteToken,
        Side side,
        uint256 price
    );

    event OrderMatched(
        uint256 indexed makerOrderId,
        uint256 indexed takerOrderId,
        address indexed takerUser,
        address nft,
        uint256 tokenId,
        address quoteToken,
        uint256 price
    );

    event OrderCancelled(uint256 indexed orderId);
    event RateLimitHit(
        address indexed user,
        address indexed nft,
        address indexed quoteToken,
        uint256 blockNumber
    );
    event ActiveMarketChanged(
        address indexed nft,
        uint256 indexed tokenId,
        address indexed quoteToken,
        bool active
    );

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

    // =========================================================
    // Views
    // =========================================================

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getOrderBook(
        address nft,
        uint256 tokenId,
        address quoteToken
    ) external view returns (uint256[] memory bids, uint256[] memory asks) {
        bids = _collectOrderIds(marketBooks[nft][tokenId][quoteToken][Side.Bid]);
        asks = _collectOrderIds(marketBooks[nft][tokenId][quoteToken][Side.Ask]);
    }

    function getActiveMarketCount() external view returns (uint256) {
        return activeMarkets.length;
    }

    function getActiveMarketAt(
        uint256 index
    ) external view returns (address nft, uint256 tokenId, address quoteToken) {
        if (index >= activeMarkets.length) revert IndexOutOfRange();
        MarketKey memory m = activeMarkets[index];
        return (m.nft, m.tokenId, m.quoteToken);
    }

    // =========================================================
    // Place Order
    // =========================================================

    function placeOrder(
        address feeToken,
        address nft,
        uint256 tokenId,
        address quoteToken,
        Side side,
        uint256 price,
        uint256 expiry
    ) external onlyAccount returns (uint256) {
        if (nft == address(0)) revert ZeroAddress();
        if (!_isQuoteToken(quoteToken)) revert InvalidQuoteToken();
        if (price == 0) revert InvalidPrice();
        if (!_isERC721(nft)) revert InvalidNft();

        if (unmatchedOrderCount[msg.sender][nft][quoteToken] >= maxUnmatchedOrders) {
            revert MaxUnmatchedOrdersReached();
        }

        if (expiry == 0) {
            expiry = block.timestamp + 30 days;
        } else {
            if (expiry <= block.timestamp) revert InvalidExpiry();
        }

        // rate limit per block per collection/quote
        if (block.number != lastOrderBlock[msg.sender][nft][quoteToken]) {
            ordersInBlock[msg.sender][nft][quoteToken] = 0;
            lastOrderBlock[msg.sender][nft][quoteToken] = block.number;
        }
        if (ordersInBlock[msg.sender][nft][quoteToken] >= maxOrdersPerBlock) {
            emit RateLimitHit(msg.sender, nft, quoteToken, block.number);
            revert TooManyOrdersThisBlock();
        }
        ordersInBlock[msg.sender][nft][quoteToken]++;

        // Lock offered asset and fee budgets
        FeeManager.FeeOutput memory fee;

        if (side == Side.Ask) {
            // seller locks the NFT
            vault.lockERC721(msg.sender, nft, tokenId);

            // NFT sellers do not pay protocol trading fees.
            fee = FeeManager.FeeOutput({
                fixedAmount: 0,
                fixedToken: feeToken,
                percentageAmount: 0,
                percentageToken: feeToken
            });
        } else {
            // buyer locks quote token
            _lockQuoteAsset(msg.sender, quoteToken, price);

            // buyer fees are budgeted off locked quote
            fee = _lockFees(msg.sender, feeToken, quoteToken, price, false);
        }

        Order memory taker = Order({
            orderId: 0,
            user: msg.sender,
            nft: nft,
            tokenId: tokenId,
            quoteToken: quoteToken,
            side: side,
            price: price,
            expiry: expiry,
            fixedFeeAmount: fee.fixedAmount,
            fixedFeeToken: fee.fixedToken,
            percentageFeeAmount: fee.percentageAmount,
            percentageFeeToken: fee.percentageToken,
            fixedFeeCharged: false,
            percentageFeeCharged: 0,
            prev: 0,
            next: 0,
            userIndex: 0
        });

        OrderBookSide storage opposingBook = marketBooks[nft][tokenId][quoteToken][
            side == Side.Bid ? Side.Ask : Side.Bid
        ];

        uint256 opposingId = opposingBook.head;

        while (opposingId != 0) {
            Order storage maker = orders[opposingId];
            uint256 next = maker.next;

            if (_isExpired(maker)) {
                _cancelAndRemoveExpired(opposingBook, opposingId);
                opposingId = next;
                continue;
            }

            if (_isMatchable(maker, taker)) {
                _executeTradeAndFees(maker, taker);

                _removeOrder(opposingBook, maker.orderId);

                // fully matched, taker never rests
                emit OrderMatched(
                    maker.orderId,
                    0,
                    msg.sender,
                    nft,
                    tokenId,
                    quoteToken,
                    maker.price
                );
                return 0;
            }

            // because book is sorted, if best doesn't match nothing deeper will help
            break;
        }

        if (side == Side.Bid) {
            _unlockUnchargedFeeBudgetsMemory(taker);
            FeeManager.FeeOutput memory makerFee = _lockFees(
                msg.sender,
                feeToken,
                quoteToken,
                price,
                true
            );
            taker.fixedFeeAmount = makerFee.fixedAmount;
            taker.fixedFeeToken = makerFee.fixedToken;
            taker.percentageFeeAmount = makerFee.percentageAmount;
            taker.percentageFeeToken = makerFee.percentageToken;
            taker.fixedFeeCharged = false;
            taker.percentageFeeCharged = 0;
        }

        uint256 orderId = nextOrderId++;
        taker.orderId = orderId;
        orders[orderId] = taker;

        _insertOrder(marketBooks[nft][tokenId][quoteToken][side], orderId);

        emit OrderPlaced(orderId, msg.sender, nft, tokenId, quoteToken, side, price);
        return orderId;
    }

    // =========================================================
    // Accept existing order directly
    // =========================================================

    function acceptOrder(uint256 makerOrderId, address feeToken) external onlyAccount {
        Order storage maker = orders[makerOrderId];
        if (maker.user == address(0)) revert OrderDoesNotExist();
        if (_isExpired(maker)) revert OrderExpired();

        Side takerSide = maker.side == Side.Bid ? Side.Ask : Side.Bid;

        FeeManager.FeeOutput memory fee;

        if (takerSide == Side.Ask) {
            // seller accepts bid -> seller locks NFT
            vault.lockERC721(msg.sender, maker.nft, maker.tokenId);
            // NFT sellers do not pay protocol trading fees.
            fee = FeeManager.FeeOutput({
                fixedAmount: 0,
                fixedToken: feeToken,
                percentageAmount: 0,
                percentageToken: feeToken
            });
        } else {
            // buyer accepts ask -> buyer locks quote
            _lockQuoteAsset(msg.sender, maker.quoteToken, maker.price);
            fee = _lockFees(msg.sender, feeToken, maker.quoteToken, maker.price, false);
        }

        Order memory taker = Order({
            orderId: 0,
            user: msg.sender,
            nft: maker.nft,
            tokenId: maker.tokenId,
            quoteToken: maker.quoteToken,
            side: takerSide,
            price: maker.price,
            expiry: block.timestamp + 1,
            fixedFeeAmount: fee.fixedAmount,
            fixedFeeToken: fee.fixedToken,
            percentageFeeAmount: fee.percentageAmount,
            percentageFeeToken: fee.percentageToken,
            fixedFeeCharged: false,
            percentageFeeCharged: 0,
            prev: 0,
            next: 0,
            userIndex: 0
        });

        _executeTradeAndFees(maker, taker);

        _removeOrder(
            marketBooks[maker.nft][maker.tokenId][maker.quoteToken][maker.side],
            makerOrderId
        );

        emit OrderMatched(
            makerOrderId,
            0,
            msg.sender,
            maker.nft,
            maker.tokenId,
            maker.quoteToken,
            maker.price
        );
    }

    // =========================================================
    // Cancel / Sweep
    // =========================================================

    function cancelOrder(uint256 orderId) external onlyAccount {
        Order storage o = orders[orderId];
        if (o.user == address(0)) revert OrderDoesNotExist();
        if (o.user != msg.sender) revert NotOrderOwner();

        _unlockRemainingOffered(o);
        _unlockRemainingFeeBudgets(o);

        _removeOrder(marketBooks[o.nft][o.tokenId][o.quoteToken][o.side], orderId);

        emit OrderCancelled(orderId);
    }

    function sweepExpiredOrders(
        address nft,
        uint256 tokenId,
        address quoteToken,
        Side side,
        uint256 limit
    ) external onlyAdmin {
        OrderBookSide storage book = marketBooks[nft][tokenId][quoteToken][side];
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

    // =========================================================
    // Matching / Settlement
    // =========================================================

    function _isMatchable(Order storage maker, Order memory taker) internal view returns (bool) {
        if (maker.nft != taker.nft) return false;
        if (maker.tokenId != taker.tokenId) return false;
        if (maker.quoteToken != taker.quoteToken) return false;
        if (maker.side == taker.side) return false;

        if (taker.side == Side.Bid) {
            return taker.price >= maker.price;
        } else {
            return taker.price <= maker.price;
        }
    }

    function _executeTradeAndFees(Order storage maker, Order memory taker) internal {
        address buyer = maker.side == Side.Bid ? maker.user : taker.user;
        address seller = maker.side == Side.Bid ? taker.user : maker.user;

        // NFT from seller -> buyer
        vault.transferERC721(seller, buyer, maker.nft, maker.tokenId, "NFT Spot Trade");

        // quote from buyer -> seller
        _transferQuoteAsset(buyer, seller, maker.quoteToken, maker.price, "NFT Spot Trade");

        _chargeFixedIfNeededStorage(maker);
        _chargePctFullStorage(maker);

        _chargeFixedIfNeededMemory(taker);
        _chargePctFullMemory(taker);
    }

    // =========================================================
    // Fee logic
    // =========================================================

    function _chargeFixedIfNeededStorage(Order storage o) internal {
        if (!o.fixedFeeCharged) {
            o.fixedFeeCharged = true;
            if (o.fixedFeeAmount > 0) {
                vault.chargeFee(o.user, o.fixedFeeToken, o.fixedFeeAmount, FEE_CONTEXT, true);
            }
        }
    }

    function _chargeFixedIfNeededMemory(Order memory o) internal {
        if (!o.fixedFeeCharged) {
            o.fixedFeeCharged = true;
            if (o.fixedFeeAmount > 0) {
                vault.chargeFee(o.user, o.fixedFeeToken, o.fixedFeeAmount, FEE_CONTEXT, true);
            }
        }
    }

    function _chargePctFullStorage(Order storage o) internal {
        uint256 rem =
            o.percentageFeeAmount > o.percentageFeeCharged
                ? (o.percentageFeeAmount - o.percentageFeeCharged)
                : 0;

        if (rem > 0) {
            vault.chargeFee(o.user, o.percentageFeeToken, rem, FEE_CONTEXT, false);
            o.percentageFeeCharged = o.percentageFeeAmount;
        }
    }

    function _chargePctFullMemory(Order memory o) internal {
        uint256 rem =
            o.percentageFeeAmount > o.percentageFeeCharged
                ? (o.percentageFeeAmount - o.percentageFeeCharged)
                : 0;

        if (rem > 0) {
            vault.chargeFee(o.user, o.percentageFeeToken, rem, FEE_CONTEXT, false);
            o.percentageFeeCharged = o.percentageFeeAmount;
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
            _lockFeeAsset(account, fee.fixedToken, fee.fixedAmount);
        }

        if (fee.percentageAmount > 0) {
            _lockFeeAsset(account, fee.percentageToken, fee.percentageAmount);
        }
    }

    function _unlockUnchargedFeeBudgetsMemory(Order memory o) internal {
        if (!o.fixedFeeCharged && o.fixedFeeAmount > 0) {
            _unlockFeeAsset(o.user, o.fixedFeeToken, o.fixedFeeAmount);
        }

        uint256 pctRemain =
            o.percentageFeeAmount > o.percentageFeeCharged
                ? (o.percentageFeeAmount - o.percentageFeeCharged)
                : 0;
        if (pctRemain > 0) {
            _unlockFeeAsset(o.user, o.percentageFeeToken, pctRemain);
        }
    }

    function _unlockRemainingOffered(Order storage o) internal {
        if (o.side == Side.Ask) {
            vault.unlockERC721(o.user, o.nft, o.tokenId);
        } else {
            _unlockQuoteAsset(o.user, o.quoteToken, o.price);
        }
    }

    function _unlockRemainingFeeBudgets(Order storage o) internal {
        if (o.fixedFeeAmount > 0 && !o.fixedFeeCharged) {
            _unlockFeeAsset(o.user, o.fixedFeeToken, o.fixedFeeAmount);
        }

        uint256 pctRemain =
            o.percentageFeeAmount > o.percentageFeeCharged
                ? (o.percentageFeeAmount - o.percentageFeeCharged)
                : 0;

        if (pctRemain > 0) {
            _unlockFeeAsset(o.user, o.percentageFeeToken, pctRemain);
        }
    }

    // =========================================================
    // Book operations
    // =========================================================

    function _insertOrder(OrderBookSide storage book, uint256 orderId) internal {
        Order storage newOrder = orders[orderId];

        _activateMarketIfNeeded(newOrder.nft, newOrder.tokenId, newOrder.quoteToken);
        bytes32 h = _marketHash(newOrder.nft, newOrder.tokenId, newOrder.quoteToken);
        activeMarketOrderCount[h] += 1;

        unmatchedOrderCount[newOrder.user][newOrder.nft][newOrder.quoteToken]++;

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

        if (unmatchedOrderCount[o.user][o.nft][o.quoteToken] > 0) {
            unmatchedOrderCount[o.user][o.nft][o.quoteToken]--;
        }

        if (o.prev != 0) orders[o.prev].next = o.next;
        else book.head = o.next;

        if (o.next != 0) orders[o.next].prev = o.prev;
        else book.tail = o.prev;

        uint256 idx = o.userIndex;
        if (userOrders[o.user].length > idx && userOrders[o.user][idx] == orderId) {
            userOrders[o.user][idx] = 0;
            userOrderFreeSlots[o.user].push(idx);
        }

        bytes32 h = _marketHash(o.nft, o.tokenId, o.quoteToken);
        if (activeMarketOrderCount[h] > 0) activeMarketOrderCount[h] -= 1;
        if (activeMarketOrderCount[h] == 0) {
            _deactivateMarketIfNeeded(o.nft, o.tokenId, o.quoteToken);
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

    // =========================================================
    // Utils
    // =========================================================

    function _isQuoteToken(address token) internal view returns (bool) {
        if (token == address(0)) {
            return true;
        }

        return _isERC20(token);
    }

    function _lockQuoteAsset(address account, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.lockETH(account, amount);
        } else {
            vault.lockERC20(account, token, amount);
        }
    }

    function _unlockQuoteAsset(address account, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.unlockETH(account, amount);
        } else {
            vault.unlockERC20(account, token, amount);
        }
    }

    function _transferQuoteAsset(
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

    function _lockFeeAsset(address account, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.lockETH(account, amount);
        } else {
            vault.lockERC20(account, token, amount);
        }
    }

    function _unlockFeeAsset(address account, address token, uint256 amount) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            vault.unlockETH(account, amount);
        } else {
            vault.unlockERC20(account, token, amount);
        }
    }

    function _isExpired(Order storage o) internal view returns (bool) {
        return o.expiry != 0 && block.timestamp > o.expiry;
    }

    function _isERC20(address token) internal view returns (bool) {
        try IERC20(token).totalSupply() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _isERC721(address nft) internal view returns (bool) {
        try IERC165(nft).supportsInterface(0x80ac58cd) returns (bool ok) {
            return ok;
        } catch {
            return false;
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

    function _marketHash(
        address nft,
        uint256 tokenId,
        address quoteToken
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nft, tokenId, quoteToken));
    }

    function _activateMarketIfNeeded(address nft, uint256 tokenId, address quoteToken) internal {
        bytes32 h = _marketHash(nft, tokenId, quoteToken);
        if (isActiveMarket[h]) return;

        isActiveMarket[h] = true;
        activeMarketIndexPlus1[h] = activeMarkets.length + 1;
        activeMarkets.push(MarketKey({ nft: nft, tokenId: tokenId, quoteToken: quoteToken }));

        emit ActiveMarketChanged(nft, tokenId, quoteToken, true);
    }

    function _deactivateMarketIfNeeded(address nft, uint256 tokenId, address quoteToken) internal {
        bytes32 h = _marketHash(nft, tokenId, quoteToken);
        uint256 idxPlus1 = activeMarketIndexPlus1[h];
        if (idxPlus1 == 0) return;

        uint256 idx = idxPlus1 - 1;
        uint256 last = activeMarkets.length - 1;

        if (idx != last) {
            MarketKey memory moved = activeMarkets[last];
            activeMarkets[idx] = moved;
            activeMarketIndexPlus1[_marketHash(moved.nft, moved.tokenId, moved.quoteToken)] =
                idx + 1;
        }

        activeMarkets.pop();
        delete isActiveMarket[h];
        delete activeMarketIndexPlus1[h];

        emit ActiveMarketChanged(nft, tokenId, quoteToken, false);
    }
}
