// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { LendingContract } from "./LendingContract.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

contract LendingOrderBook is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant LIQUIDATION_ENGINE_ROLE = keccak256("LIQUIDATION_ENGINE_ROLE");

    string internal constant VAULT_TRANSFER_REASON = "Lending match principal";

    // -------- Errors --------
    error NotRegisteredAccount();
    error ZeroAddress();
    error UnsupportedToken();

    error InvalidPrincipal();
    error InvalidRate();
    error OrderExpired();
    error OnlyLendingAccount();

    error MarketRiskMismatch();
    error RolloverRiskMismatch();
    error BorrowTokenMismatch();
    error MarketInactive();
    error MarketExpired();
    error MarketAlreadySettled();
    error OrderExpiryAfterMarketExpiry();

    error InvalidRepayMarket();
    error SameMarketRollover();
    error NoRolloverDebt();
    error RolloverExceedsDebt();

    error NotOrderOwner();
    error OrderAlreadyCancelled();
    error InvalidAccount();

    error OrderMarketMismatch();
    error OrderRiskMismatch();
    error OrderNotFound();

    error TooManyOrdersThisBlock();
    error TooManyOpenOrders();
    error InvalidOrderLimits();

    enum Side {
        Lend,
        Borrow
    }

    struct Order {
        uint256 orderId;
        address user;
        bytes32 marketKey;
        uint16 riskLevel;
        Side side;
        uint256 principal;
        uint256 initialPrincipal;
        uint256 rateBps;
        uint64 orderExpiry;
        uint64 timestamp;
        uint256 collateralLocked;
        bool isRollover;
        bytes32 repayMarketKey;
    }

    LendingContract public immutable lending;
    SethxVault public immutable vault;
    AccountRegistry public immutable accountRegistry;

    uint256 public nextOrderId = 1;

    uint256 public maxOrdersPerBlock;
    uint256 public maxUnmatchedOrders;

    mapping(address => mapping(bytes32 => uint256)) public lastOrderBlock;
    mapping(address => mapping(bytes32 => uint256)) public ordersInBlock;
    mapping(address => mapping(bytes32 => uint256)) public unmatchedOrderCount;
    mapping(uint256 => bool) public isOrderInBook;

    mapping(bytes32 => uint256[]) public lendBook;
    mapping(bytes32 => uint256[]) public borrowBook;

    mapping(uint256 => Order) public ordersById;
    mapping(address => uint256[]) public userOrders;
    mapping(uint256 => bool) public isOrderCancelled;
    mapping(address => mapping(bytes32 => uint256)) public pendingRolloverRepayPrincipal;

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed marketKey,
        uint16 riskLevel,
        Side side,
        uint256 principal,
        uint256 rateBps,
        uint256 orderExpiry
    );

    event OrderMatched(
        uint256 indexed takerOrderId,
        uint256 indexed makerOrderId,
        uint256 principal,
        uint256 rateBps,
        uint256 faceValue,
        uint256 bondIndex
    );

    event RolloverMatched(
        uint256 indexed takerOrderId,
        uint256 indexed makerOrderId,
        bytes32 indexed repayMarketKey,
        uint256 principal,
        uint256 appliedToOldDebt,
        uint256 faceValue,
        uint256 bondIndex
    );

    event OrderCancelled(uint256 indexed orderId);
    event OrderExpiredCancelled(uint256 indexed orderId);
    event OrderCancelledForLiquidation(
        uint256 indexed orderId,
        address indexed account,
        bytes32 indexed marketKey
    );

    event LiquidationEngineSet(address indexed engine, bool allowed);

    event OrderLimitsSet(uint256 maxOrdersPerBlock, uint256 maxUnmatchedOrders);

    modifier onlyProtocolAccount() {
        if (!accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender))
            revert NotRegisteredAccount();
        _;
    }

    constructor(address _vault, address _accountRegistry, address _lendingContract, address admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_lendingContract == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        lending = LendingContract(payable(_lendingContract));

        maxOrdersPerBlock = 20;
        maxUnmatchedOrders = 100;

        emit OrderLimitsSet(20, 100);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setLiquidationEngine(address engine, bool allowed) external onlyRole(GOVERNOR_ROLE) {
        if (engine == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(LIQUIDATION_ENGINE_ROLE, engine);
        } else {
            _revokeRole(LIQUIDATION_ENGINE_ROLE, engine);
        }
        emit LiquidationEngineSet(engine, allowed);
    }

    function setOrderLimits(
        uint256 newMaxOrdersPerBlock,
        uint256 newMaxUnmatchedOrders
    ) external onlyRole(GOVERNOR_ROLE) {
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

    function getBook(
        bytes32 marketKey,
        bool wantLendBook
    ) external view returns (uint256[] memory) {
        return wantLendBook ? lendBook[marketKey] : borrowBook[marketKey];
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

    function placeOrder(
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        Side side,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry
    ) external onlyProtocolAccount {
        if (principal == 0) revert InvalidPrincipal();
        if (orderExpiry <= block.timestamp) revert OrderExpired();
        if (rateBps == 0) revert InvalidRate();

        if (side == Side.Borrow) {
            if (!accountRegistry.isLendingAccount(msg.sender)) revert OnlyLendingAccount();
        }

        bytes32 marketKey = lending.ensureMarket(borrowToken, marketExpiry, riskLevel);

        _checkAndRecordOrderLimit(msg.sender, marketKey);

        LendingContract.MarketConfig memory m = lending.getMarket(marketKey);
        LendingContract.MarketSettlement memory ms = lending.getMarketSettlement(marketKey);

        if (m.riskLevel != riskLevel) revert MarketRiskMismatch();
        if (!m.active) revert MarketInactive();
        if (m.expiry <= block.timestamp) revert MarketExpired();
        if (ms.primarySettled) revert MarketAlreadySettled();
        if (orderExpiry > m.expiry) revert OrderExpiryAfterMarketExpiry();

        uint256 orderId = nextOrderId++;
        ordersById[orderId] = Order({
            orderId: orderId,
            user: msg.sender,
            marketKey: marketKey,
            riskLevel: riskLevel,
            side: side,
            principal: principal,
            initialPrincipal: principal,
            rateBps: rateBps,
            orderExpiry: orderExpiry,
            timestamp: uint64(block.timestamp),
            collateralLocked: 0,
            isRollover: false,
            repayMarketKey: bytes32(0)
        });

        userOrders[msg.sender].push(orderId);

        if (side == Side.Lend) {
            _lockPrincipal(msg.sender, m.borrowToken, principal);
            ordersById[orderId].collateralLocked = principal;

            _matchBorrowTaker(orderId);

            if (ordersById[orderId].principal > 0 && !isOrderCancelled[orderId]) {
                _insertLend(orderId);
                isOrderInBook[orderId] = true;
                unmatchedOrderCount[msg.sender][marketKey]++;
            }
        } else {
            lending.onBorrowOrderPlaced(msg.sender, marketKey, principal);

            _matchLendTaker(orderId);

            if (ordersById[orderId].principal > 0 && !isOrderCancelled[orderId]) {
                _insertBorrow(orderId);
                isOrderInBook[orderId] = true;
                unmatchedOrderCount[msg.sender][marketKey]++;
            }
        }

        emit OrderPlaced(
            orderId,
            msg.sender,
            marketKey,
            riskLevel,
            side,
            principal,
            rateBps,
            orderExpiry
        );
    }

    function placeRolloverBorrowOrder(
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry,
        bytes32 repayMarketKey
    ) external onlyProtocolAccount {
        if (!accountRegistry.isLendingAccount(msg.sender)) revert OnlyLendingAccount();
        if (principal == 0) revert InvalidPrincipal();
        if (orderExpiry <= block.timestamp) revert OrderExpired();
        if (rateBps == 0) revert InvalidRate();
        if (repayMarketKey == bytes32(0)) revert InvalidRepayMarket();

        bytes32 marketKey = lending.ensureMarket(borrowToken, marketExpiry, riskLevel);
        if (marketKey == repayMarketKey) revert SameMarketRollover();
        _checkAndRecordOrderLimit(msg.sender, marketKey);

        LendingContract.MarketConfig memory m = lending.getMarket(marketKey);
        LendingContract.MarketConfig memory repayMarket = lending.getMarket(repayMarketKey);
        LendingContract.MarketSettlement memory ms = lending.getMarketSettlement(marketKey);

        if (m.riskLevel != riskLevel) revert MarketRiskMismatch();
        if (repayMarket.riskLevel != riskLevel) revert RolloverRiskMismatch();
        if (repayMarket.borrowToken != m.borrowToken) revert BorrowTokenMismatch();
        if (!m.active) revert MarketInactive();
        if (m.expiry <= block.timestamp) revert MarketExpired();
        if (ms.primarySettled) revert MarketAlreadySettled();
        if (orderExpiry > m.expiry) revert OrderExpiryAfterMarketExpiry();

        LendingContract.DebtPosition memory repayDebt = lending.getDebt(msg.sender, repayMarketKey);
        if (repayDebt.faceValue == 0) revert NoRolloverDebt();
        if (
            pendingRolloverRepayPrincipal[msg.sender][repayMarketKey] + principal >
            repayDebt.faceValue
        ) revert RolloverExceedsDebt();

        lending.onRolloverBorrowOrderPlaced(msg.sender, marketKey, principal, repayMarketKey);
        pendingRolloverRepayPrincipal[msg.sender][repayMarketKey] += principal;

        uint256 orderId = nextOrderId++;
        ordersById[orderId] = Order({
            orderId: orderId,
            user: msg.sender,
            marketKey: marketKey,
            riskLevel: riskLevel,
            side: Side.Borrow,
            principal: principal,
            initialPrincipal: principal,
            rateBps: rateBps,
            orderExpiry: orderExpiry,
            timestamp: uint64(block.timestamp),
            collateralLocked: 0,
            isRollover: true,
            repayMarketKey: repayMarketKey
        });

        userOrders[msg.sender].push(orderId);

        _matchLendTaker(orderId);

        if (ordersById[orderId].principal > 0 && !isOrderCancelled[orderId]) {
            _insertBorrow(orderId);
            isOrderInBook[orderId] = true;
            unmatchedOrderCount[msg.sender][marketKey]++;
        }

        emit OrderPlaced(
            orderId,
            msg.sender,
            marketKey,
            riskLevel,
            Side.Borrow,
            principal,
            rateBps,
            orderExpiry
        );
    }

    function cancelOrder(uint256 orderId) external {
        Order storage o = ordersById[orderId];
        if (o.user == address(0)) revert OrderNotFound();
        if (o.user != msg.sender) revert NotOrderOwner();
        if (isOrderCancelled[orderId]) revert OrderAlreadyCancelled();

        _cancelOrder(orderId, false, false);
    }

    /// @notice Cancel all open orders for an account before liquidation auction starts.
    /// @dev Releases lender-locked balances and clears pending borrow accounting.
    function cancelAllOrdersForAccount(
        address account
    ) external onlyRole(LIQUIDATION_ENGINE_ROLE) returns (uint256 cancelledCount) {
        if (account == address(0)) revert InvalidAccount();

        uint256[] storage ids = userOrders[account];
        uint256 len = ids.length;

        for (uint256 i = 0; i < len; i++) {
            uint256 orderId = ids[i];
            if (_isCancellableOpenOrder(orderId)) {
                _cancelOrder(orderId, false, true);
                cancelledCount++;
            }
        }
    }

    function _matchBorrowTaker(uint256 takerOrderId) internal {
        Order storage taker = ordersById[takerOrderId];
        uint256[] storage makers = borrowBook[taker.marketKey];
        uint256 i = 0;

        while (taker.principal > 0 && i < makers.length) {
            uint256 makerId = makers[i];
            Order storage maker = ordersById[makerId];

            if (_shouldRemoveMaker(makerId, maker)) {
                _removeAt(makers, i);
                continue;
            }

            if (maker.marketKey != taker.marketKey) revert OrderMarketMismatch();
            if (maker.riskLevel != taker.riskLevel) revert OrderRiskMismatch();

            if (maker.rateBps < taker.rateBps) {
                break;
            }

            uint256 matchedPrincipal =
                taker.principal < maker.principal ? taker.principal : maker.principal;

            if (maker.isRollover) {
                LendingContract.DebtPosition memory repayDebt = lending.getDebt(
                    maker.user,
                    maker.repayMarketKey
                );
                if (repayDebt.faceValue == 0) {
                    _cancelOrder(makerId, false, false);
                    _removeAt(makers, i);
                    continue;
                }
                if (matchedPrincipal > repayDebt.faceValue) {
                    matchedPrincipal = repayDebt.faceValue;
                }
            }

            uint256 execRateBps = maker.rateBps;
            LendingContract.MarketConfig memory m = lending.getMarket(taker.marketKey);

            uint256 bondIndex;
            uint256 faceValue;
            uint256 appliedToOldDebt;

            (bondIndex, faceValue) = lending.executeMatch(
                taker.user,
                maker.user,
                taker.marketKey,
                matchedPrincipal,
                execRateBps
            );
            _transferPrincipal(taker.user, maker.user, m.borrowToken, matchedPrincipal);
            if (maker.isRollover) {
                lending.onRolloverBorrowOrderMatched(maker.user, maker.marketKey, matchedPrincipal);
                appliedToOldDebt = lending.repayDebtFromAccountVaultFor(
                    maker.user,
                    maker.repayMarketKey,
                    matchedPrincipal
                );
                _releaseRolloverRepay(maker.user, maker.repayMarketKey, matchedPrincipal);
            }

            taker.principal -= matchedPrincipal;
            maker.principal -= matchedPrincipal;
            taker.collateralLocked -= matchedPrincipal;

            emit OrderMatched(
                takerOrderId,
                makerId,
                matchedPrincipal,
                execRateBps,
                faceValue,
                bondIndex
            );

            if (maker.isRollover) {
                emit RolloverMatched(
                    takerOrderId,
                    makerId,
                    maker.repayMarketKey,
                    matchedPrincipal,
                    appliedToOldDebt,
                    faceValue,
                    bondIndex
                );
                LendingContract.DebtPosition memory repayDebtAfter = lending.getDebt(
                    maker.user,
                    maker.repayMarketKey
                );
                if (repayDebtAfter.faceValue == 0 && maker.principal > 0) {
                    _cancelOrder(makerId, false, false);
                }
            }

            if (maker.principal == 0) {
                _clearRestingOrderCount(makerId);
                _removeAt(makers, i);
                isOrderCancelled[makerId] = true;
            } else {
                i++;
            }
        }
    }

    function _matchLendTaker(uint256 takerOrderId) internal {
        Order storage taker = ordersById[takerOrderId];
        uint256[] storage makers = lendBook[taker.marketKey];
        uint256 i = 0;

        while (taker.principal > 0 && i < makers.length) {
            uint256 makerId = makers[i];
            Order storage maker = ordersById[makerId];

            if (_shouldRemoveMaker(makerId, maker)) {
                _removeAt(makers, i);
                continue;
            }

            if (maker.marketKey != taker.marketKey) revert OrderMarketMismatch();
            if (maker.riskLevel != taker.riskLevel) revert OrderRiskMismatch();

            if (taker.rateBps < maker.rateBps) {
                break;
            }

            uint256 matchedPrincipal =
                taker.principal < maker.principal ? taker.principal : maker.principal;

            if (taker.isRollover) {
                LendingContract.DebtPosition memory repayDebt = lending.getDebt(
                    taker.user,
                    taker.repayMarketKey
                );
                if (repayDebt.faceValue == 0) {
                    _cancelOrder(takerOrderId, false, false);
                    break;
                }
                if (matchedPrincipal > repayDebt.faceValue) {
                    matchedPrincipal = repayDebt.faceValue;
                }
            }

            uint256 execRateBps = maker.rateBps;
            LendingContract.MarketConfig memory m = lending.getMarket(taker.marketKey);

            uint256 bondIndex;
            uint256 faceValue;
            uint256 appliedToOldDebt;

            (bondIndex, faceValue) = lending.executeMatch(
                maker.user,
                taker.user,
                taker.marketKey,
                matchedPrincipal,
                execRateBps
            );
            _transferPrincipal(maker.user, taker.user, m.borrowToken, matchedPrincipal);
            if (taker.isRollover) {
                lending.onRolloverBorrowOrderMatched(taker.user, taker.marketKey, matchedPrincipal);
                appliedToOldDebt = lending.repayDebtFromAccountVaultFor(
                    taker.user,
                    taker.repayMarketKey,
                    matchedPrincipal
                );
                _releaseRolloverRepay(taker.user, taker.repayMarketKey, matchedPrincipal);
            }

            taker.principal -= matchedPrincipal;
            maker.principal -= matchedPrincipal;
            maker.collateralLocked -= matchedPrincipal;

            emit OrderMatched(
                takerOrderId,
                makerId,
                matchedPrincipal,
                execRateBps,
                faceValue,
                bondIndex
            );

            if (taker.isRollover) {
                emit RolloverMatched(
                    takerOrderId,
                    makerId,
                    taker.repayMarketKey,
                    matchedPrincipal,
                    appliedToOldDebt,
                    faceValue,
                    bondIndex
                );
                LendingContract.DebtPosition memory repayDebtAfter = lending.getDebt(
                    taker.user,
                    taker.repayMarketKey
                );
                if (repayDebtAfter.faceValue == 0 && taker.principal > 0) {
                    _cancelOrder(takerOrderId, false, false);
                }
            }

            if (maker.principal == 0) {
                _clearRestingOrderCount(makerId);
                _removeAt(makers, i);
                isOrderCancelled[makerId] = true;
            } else {
                i++;
            }
        }
    }

    function _clearRestingOrderCount(uint256 orderId) internal {
        if (!isOrderInBook[orderId]) return;

        Order storage o = ordersById[orderId];

        isOrderInBook[orderId] = false;

        if (unmatchedOrderCount[o.user][o.marketKey] > 0) {
            unmatchedOrderCount[o.user][o.marketKey]--;
        }
    }

    function _shouldRemoveMaker(uint256 makerId, Order storage maker) internal returns (bool) {
        if (isOrderCancelled[makerId]) return true;
        if (maker.principal == 0) return true;

        LendingContract.MarketConfig memory m = lending.getMarket(maker.marketKey);
        LendingContract.MarketSettlement memory ms = lending.getMarketSettlement(maker.marketKey);

        if (!m.active || m.expiry <= block.timestamp || ms.primarySettled) {
            _cancelOrder(makerId, true, false);
            return true;
        }

        if (maker.orderExpiry <= block.timestamp) {
            _cancelOrder(makerId, true, false);
            return true;
        }

        return false;
    }

    function _insertLend(uint256 orderId) internal {
        uint256[] storage book = lendBook[ordersById[orderId].marketKey];
        book.push(orderId);
        uint256 i = book.length - 1;

        while (i > 0 && _lendComesBefore(orderId, book[i - 1])) {
            book[i] = book[i - 1];
            i--;
        }

        book[i] = orderId;
    }

    function _insertBorrow(uint256 orderId) internal {
        uint256[] storage book = borrowBook[ordersById[orderId].marketKey];
        book.push(orderId);
        uint256 i = book.length - 1;

        while (i > 0 && _borrowComesBefore(orderId, book[i - 1])) {
            book[i] = book[i - 1];
            i--;
        }

        book[i] = orderId;
    }

    function _lendComesBefore(uint256 aId, uint256 bId) internal view returns (bool) {
        Order storage a = ordersById[aId];
        Order storage b = ordersById[bId];
        if (a.rateBps != b.rateBps) return a.rateBps < b.rateBps;
        return a.timestamp < b.timestamp;
    }

    function _borrowComesBefore(uint256 aId, uint256 bId) internal view returns (bool) {
        Order storage a = ordersById[aId];
        Order storage b = ordersById[bId];
        if (a.rateBps != b.rateBps) return a.rateBps > b.rateBps;
        return a.timestamp < b.timestamp;
    }

    function _removeAt(uint256[] storage arr, uint256 index) internal {
        uint256 last = arr.length - 1;
        for (uint256 j = index; j < last; j++) {
            arr[j] = arr[j + 1];
        }
        arr.pop();
    }

    function _isCancellableOpenOrder(uint256 orderId) internal view returns (bool) {
        if (isOrderCancelled[orderId]) return false;
        if (ordersById[orderId].user == address(0)) return false;
        if (ordersById[orderId].principal == 0) return false;
        return true;
    }

    function _cancelOrder(uint256 orderId, bool expired, bool fromLiquidation) internal {
        Order storage o = ordersById[orderId];
        if (isOrderCancelled[orderId]) return;

        isOrderCancelled[orderId] = true;

        if (o.principal > 0) {
            _clearRestingOrderCount(orderId);
            if (o.side == Side.Lend) {
                LendingContract.MarketConfig memory m = lending.getMarket(o.marketKey);
                _unlockPrincipal(o.user, m.borrowToken, o.principal);
                o.collateralLocked = 0;
            } else {
                if (o.isRollover) {
                    lending.onRolloverBorrowOrderCancelled(
                        o.user,
                        o.marketKey,
                        o.principal,
                        o.repayMarketKey
                    );
                    _releaseRolloverRepay(o.user, o.repayMarketKey, o.principal);
                } else {
                    lending.onBorrowOrderCancelled(o.user, o.marketKey, o.principal);
                }
            }

            o.principal = 0;
        }

        if (fromLiquidation) {
            emit OrderCancelledForLiquidation(orderId, o.user, o.marketKey);
        } else if (expired) {
            emit OrderExpiredCancelled(orderId);
        } else {
            emit OrderCancelled(orderId);
        }
    }

    function _releaseRolloverRepay(
        address borrower,
        bytes32 repayMarketKey,
        uint256 amount
    ) internal {
        uint256 pending = pendingRolloverRepayPrincipal[borrower][repayMarketKey];
        pendingRolloverRepayPrincipal[borrower][repayMarketKey] =
            pending > amount ? pending - amount : 0;
    }

    function _lockPrincipal(address account, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token != address(0)) revert UnsupportedToken();

        vault.lockETH(account, amount);
    }

    function _unlockPrincipal(address account, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token != address(0)) revert UnsupportedToken();

        vault.unlockETH(account, amount);
    }

    function _transferPrincipal(address from, address to, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token != address(0)) revert UnsupportedToken();

        vault.transferETH(from, to, amount, VAULT_TRANSFER_REASON);
    }
}
