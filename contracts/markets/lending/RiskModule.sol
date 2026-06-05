// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { ValuationModule } from "./ValuationModule.sol";
import { LendingOrderBook } from "./LendingOrderBook.sol";
import { LiquidationEngine } from "./LiquidationEngine.sol";

import { TokenSpotOrderBook } from "../spot/TokenSpotOrderBook.sol";

import { OptionsOrderBook } from "../options/OptionsOrderBook.sol";
import { OptionContract } from "../options/OptionContract.sol";

import { FuturesOrderBook } from "../futures/FuturesOrderBook.sol";
import { FuturesContract } from "../futures/FuturesContract.sol";

import { MarginOptionsOrderBook } from "../margin/MarginOptionsOrderBook.sol";
import { MarginOptionContract } from "../margin/MarginOptionContract.sol";

import { BinaryMarginOptionsOrderBook } from "../margin/BinaryMarginOptionsOrderBook.sol";
import { BinaryMarginOptionContract } from "../margin/BinaryMarginOptionContract.sol";

/// @notice Thin policy layer used by LendingAccount when the account is restricted.
/// @dev This module does not do valuation itself; it delegates health checks to ValuationModule.
contract RiskModule is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant LENDING_CONTRACT_ROLE = keccak256("LENDING_CONTRACT_ROLE");

    // -------- Errors --------
    error ZeroAddress();
    error InvalidRiskLevel();
    error NotRiskSetter();
    error WrongRiskLevel();
    error BadCalldata();
    error TargetNotApproved();

    error EthOnly();
    error BorrowOnly();
    error InvalidPrincipal();

    error BorrowDisallowed();
    error RolloverDisallowed();
    error TradeDisallowed();
    error MarginReleaseBlocked();

    error BadLendingAction();
    error BadSpotAction();
    error BadOptionsAction();
    error BadOptionLifecycle();
    error BadFuturesOrderAction();
    error BadFuturesLifecycle();
    error BadMarginOptionsAction();
    error BadMarginOptionLifecycle();
    error BadBinaryOptionsAction();
    error BadBinaryOptionLifecycle();
    error BadLiquidationAction();
    error AuctionPurchaseDisallowed();

    ValuationModule public immutable valuationModule;

    /// @notice Active risk tier used for policy checks for each restricted account.
    mapping(address => uint16) public accountRiskLevel;

    mapping(address => bool) public approvedLendingOrderBooks;
    mapping(address => bool) public approvedTokenSpotOrderBooks;
    mapping(address => bool) public approvedOptionsOrderBooks;
    mapping(address => bool) public approvedOptionContracts;
    mapping(address => bool) public approvedFuturesOrderBooks;
    mapping(address => bool) public approvedFuturesContracts;
    mapping(address => bool) public approvedMarginOptionsOrderBooks;
    mapping(address => bool) public approvedMarginOptionContracts;
    mapping(address => bool) public approvedBinaryMarginOptionsOrderBooks;
    mapping(address => bool) public approvedBinaryMarginOptionContracts;
    mapping(address => bool) public approvedLiquidationEngines;

    event AccountRiskLevelSet(address indexed account, uint16 indexed riskLevel);
    event LendingContractApprovalSet(address indexed target, bool allowed);

    event LendingOrderBookApprovalSet(address indexed target, bool allowed);
    event TokenSpotOrderBookApprovalSet(address indexed target, bool allowed);
    event OptionsOrderBookApprovalSet(address indexed target, bool allowed);
    event OptionContractApprovalSet(address indexed target, bool allowed);
    event FuturesOrderBookApprovalSet(address indexed target, bool allowed);
    event FuturesContractApprovalSet(address indexed target, bool allowed);
    event MarginOptionsOrderBookApprovalSet(address indexed target, bool allowed);
    event MarginOptionContractApprovalSet(address indexed target, bool allowed);
    event BinaryMarginOptionsOrderBookApprovalSet(address indexed target, bool allowed);
    event BinaryMarginOptionContractApprovalSet(address indexed target, bool allowed);
    event LiquidationEngineApprovalSet(address indexed target, bool allowed);

    constructor(address _valuationModule, address admin) {
        if (_valuationModule == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        valuationModule = ValuationModule(_valuationModule);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);

        _setRoleAdmin(RISK_ADMIN_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(LENDING_CONTRACT_ROLE, RISK_ADMIN_ROLE);
    }

    // =========================================================
    // Governance / config
    // =========================================================

    function setAccountRiskLevel(
        address account,
        uint16 riskLevel
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (riskLevel == 0) revert InvalidRiskLevel();
        accountRiskLevel[account] = riskLevel;
        emit AccountRiskLevelSet(account, riskLevel);
    }

    function clearAccountRiskLevel(address account) external {
        if (account == address(0)) revert ZeroAddress();
        if (!hasRole(RISK_ADMIN_ROLE, msg.sender) && !hasRole(LENDING_CONTRACT_ROLE, msg.sender))
            revert NotRiskSetter();
        if (accountRiskLevel[account] != 0) {
            accountRiskLevel[account] = 0;
            emit AccountRiskLevelSet(account, 0);
        }
    }

    function setApprovedLendingContract(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        if (allowed) {
            _grantRole(LENDING_CONTRACT_ROLE, target);
        } else {
            _revokeRole(LENDING_CONTRACT_ROLE, target);
        }
        emit LendingContractApprovalSet(target, allowed);
    }

    function latchAccountRiskLevel(
        address account,
        uint16 riskLevel
    ) external onlyRole(LENDING_CONTRACT_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (riskLevel == 0) revert InvalidRiskLevel();
        uint16 current = accountRiskLevel[account];
        if (current == 0) {
            accountRiskLevel[account] = riskLevel;
            emit AccountRiskLevelSet(account, riskLevel);
            return;
        }
        if (current != riskLevel) revert WrongRiskLevel();
    }

    function requireAccountRiskLevel(
        address account,
        uint16 riskLevel
    ) external view onlyRole(LENDING_CONTRACT_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (riskLevel == 0) revert InvalidRiskLevel();
        if (accountRiskLevel[account] != riskLevel) revert WrongRiskLevel();
    }

    function setApprovedLendingOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedLendingOrderBooks[target] = allowed;
        emit LendingOrderBookApprovalSet(target, allowed);
    }

    function setApprovedTokenSpotOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedTokenSpotOrderBooks[target] = allowed;
        emit TokenSpotOrderBookApprovalSet(target, allowed);
    }

    function setApprovedOptionsOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedOptionsOrderBooks[target] = allowed;
        emit OptionsOrderBookApprovalSet(target, allowed);
    }

    function setApprovedOptionContract(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedOptionContracts[target] = allowed;
        emit OptionContractApprovalSet(target, allowed);
    }

    function setApprovedFuturesOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedFuturesOrderBooks[target] = allowed;
        emit FuturesOrderBookApprovalSet(target, allowed);
    }

    function setApprovedFuturesContract(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedFuturesContracts[target] = allowed;
        emit FuturesContractApprovalSet(target, allowed);
    }

    function setApprovedMarginOptionsOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedMarginOptionsOrderBooks[target] = allowed;
        emit MarginOptionsOrderBookApprovalSet(target, allowed);
    }

    function setApprovedMarginOptionContract(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedMarginOptionContracts[target] = allowed;
        emit MarginOptionContractApprovalSet(target, allowed);
    }

    function setApprovedBinaryMarginOptionsOrderBook(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedBinaryMarginOptionsOrderBooks[target] = allowed;
        emit BinaryMarginOptionsOrderBookApprovalSet(target, allowed);
    }

    function setApprovedBinaryMarginOptionContract(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedBinaryMarginOptionContracts[target] = allowed;
        emit BinaryMarginOptionContractApprovalSet(target, allowed);
    }

    function setApprovedLiquidationEngine(
        address target,
        bool allowed
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedLiquidationEngines[target] = allowed;
        emit LiquidationEngineApprovalSet(target, allowed);
    }
    // =========================================================
    // LendingAccount hook
    // =========================================================

    /// @notice Called by LendingAccount before restricted actions.
    /// @dev Reverts if action is not allowed.
    function checkActionAllowed(
        address account,
        address target,
        bytes calldata data
    ) external view {
        if (account == address(0)) revert ZeroAddress();
        if (target == address(0)) revert ZeroAddress();
        if (data.length < 4) revert BadCalldata();

        uint16 riskLevel = accountRiskLevel[account];
        bytes4 selector = bytes4(data[:4]);

        // -----------------------------------------------------
        // Lending orderbook: allow a first borrow order to be validated
        // against the decoded order risk tier before that tier is latched
        // by LendingContract.onBorrowOrderPlaced. Once latched, all later
        // borrow orders must use the same risk tier.
        // -----------------------------------------------------
        if (approvedLendingOrderBooks[target]) {
            _checkLendingOrderBookAction(account, riskLevel, selector, data[4:]);
            return;
        }

        if (riskLevel == 0) revert InvalidRiskLevel();

        // -----------------------------------------------------
        // Spot trading: permitted only if account remains trade-eligible.
        // -----------------------------------------------------
        if (approvedTokenSpotOrderBooks[target]) {
            _checkTokenSpotAction(account, riskLevel, selector);
            return;
        }

        // -----------------------------------------------------
        // Options order placement / taking:
        // permitted only if trade-eligible.
        // -----------------------------------------------------
        if (approvedOptionsOrderBooks[target]) {
            _checkOptionsOrderBookAction(account, riskLevel, selector);
            return;
        }

        // -----------------------------------------------------
        // Direct option lifecycle:
        // - exercise: allowed
        // - reclaimExpired: allowed
        // These usually reduce risk / realize value.
        // -----------------------------------------------------
        if (approvedOptionContracts[target]) {
            _checkOptionContractAction(selector);
            return;
        }

        // -----------------------------------------------------
        // Futures order placement:
        // permitted only if trade-eligible.
        // -----------------------------------------------------
        if (approvedFuturesOrderBooks[target]) {
            _checkFuturesOrderBookAction(account, riskLevel, selector);
            return;
        }

        // -----------------------------------------------------
        // Futures contract:
        // - addMargin: allowed
        // - releaseExcessMargin: blocked while restricted
        //   because it can worsen account health without simulating post-state.
        // -----------------------------------------------------
        if (approvedFuturesContracts[target]) {
            _checkFuturesContractAction(selector);
            return;
        }

        if (approvedMarginOptionsOrderBooks[target]) {
            _checkMarginOptionsOrderBookAction(account, riskLevel, selector);
            return;
        }

        if (approvedMarginOptionContracts[target]) {
            _checkMarginOptionContractAction(selector);
            return;
        }

        if (approvedBinaryMarginOptionsOrderBooks[target]) {
            _checkBinaryMarginOptionsOrderBookAction(account, riskLevel, selector);
            return;
        }

        if (approvedBinaryMarginOptionContracts[target]) {
            _checkBinaryMarginOptionContractAction(selector);
            return;
        }

        if (approvedLiquidationEngines[target]) {
            _checkLiquidationEngineAction(account, riskLevel, target, selector, data[4:]);
            return;
        }

        revert TargetNotApproved();
    }

    // =========================================================
    // Internal policy
    // =========================================================

    function _checkLendingOrderBookAction(
        address account,
        uint16 assignedRiskLevel,
        bytes4 selector,
        bytes calldata args
    ) internal view {
        if (selector == LendingOrderBook.placeOrder.selector) {
            (
                address borrowToken,
                uint64 marketExpiry,
                uint16 riskLevel,
                uint8 side,
                uint256 rateBps,
                uint256 principal,
                uint64 orderExpiry
            ) = abi.decode(args, (address, uint64, uint16, uint8, uint256, uint256, uint64));

            marketExpiry;
            rateBps;
            orderExpiry;

            if (borrowToken != address(0)) revert EthOnly();
            if (riskLevel == 0) revert InvalidRiskLevel();
            if (assignedRiskLevel != 0 && riskLevel != assignedRiskLevel) revert WrongRiskLevel();
            if (side != uint8(LendingOrderBook.Side.Borrow)) revert BorrowOnly();
            if (principal == 0) revert InvalidPrincipal();

            bool ok = valuationModule.canPlaceBorrowOrder(account, riskLevel, principal);
            if (!ok) revert BorrowDisallowed();
            return;
        }

        if (selector == LendingOrderBook.placeRolloverBorrowOrder.selector) {
            (
                address borrowToken,
                uint64 marketExpiry,
                uint16 riskLevel,
                uint256 rateBps,
                uint256 principal,
                uint64 orderExpiry,
                bytes32 repayMarketKey
            ) = abi.decode(args, (address, uint64, uint16, uint256, uint256, uint64, bytes32));

            marketExpiry;
            rateBps;
            orderExpiry;

            if (borrowToken != address(0)) revert EthOnly();
            if (riskLevel == 0) revert InvalidRiskLevel();
            if (assignedRiskLevel != 0 && riskLevel != assignedRiskLevel) revert WrongRiskLevel();
            if (principal == 0) revert InvalidPrincipal();

            bool ok = valuationModule.canPlaceRolloverBorrowOrder(
                account,
                riskLevel,
                repayMarketKey,
                principal
            );
            if (!ok) revert RolloverDisallowed();
            return;
        }

        revert BadLendingAction();
    }

    function _checkTokenSpotAction(
        address account,
        uint16 riskLevel,
        bytes4 selector
    ) internal view {
        if (
            selector == TokenSpotOrderBook.placeOrder.selector ||
            selector == TokenSpotOrderBook.acceptOrder.selector
        ) {
            if (!valuationModule.canTrade(account, riskLevel)) revert TradeDisallowed();
            return;
        }

        revert BadSpotAction();
    }

    function _checkOptionsOrderBookAction(
        address account,
        uint16 riskLevel,
        bytes4 selector
    ) internal view {
        if (
            selector == OptionsOrderBook.placeOrder.selector ||
            selector == OptionsOrderBook.acceptOrder.selector
        ) {
            if (!valuationModule.canTrade(account, riskLevel)) revert TradeDisallowed();
            return;
        }

        revert BadOptionsAction();
    }

    function _checkOptionContractAction(bytes4 selector) internal pure {
        if (
            selector == OptionContract.exercise.selector ||
            selector == OptionContract.reclaimExpired.selector
        ) {
            return;
        }

        revert BadOptionLifecycle();
    }

    function _checkFuturesOrderBookAction(
        address account,
        uint16 riskLevel,
        bytes4 selector
    ) internal view {
        if (selector == FuturesOrderBook.placeOrder.selector) {
            if (!valuationModule.canTrade(account, riskLevel)) revert TradeDisallowed();
            return;
        }

        // Imbalance matching is a maintenance call. The caller account receives
        // a fee-share reward but does not open, close, or resize its own
        // position, so it is safe for restricted accounts as long as the target
        // is an approved FuturesOrderBook.
        if (selector == FuturesOrderBook.matchImbalance.selector) {
            return;
        }

        revert BadFuturesOrderAction();
    }

    function _checkFuturesContractAction(bytes4 selector) internal pure {
        if (selector == FuturesContract.addMargin.selector) {
            return;
        }

        if (selector == FuturesContract.releaseExcessMargin.selector) {
            revert MarginReleaseBlocked();
        }

        revert BadFuturesLifecycle();
    }

    function _checkMarginOptionsOrderBookAction(
        address account,
        uint16 riskLevel,
        bytes4 selector
    ) internal view {
        if (
            selector == MarginOptionsOrderBook.placeOrder.selector ||
            selector == MarginOptionsOrderBook.acceptOrder.selector
        ) {
            if (!valuationModule.canTrade(account, riskLevel)) revert TradeDisallowed();
            return;
        }

        revert BadMarginOptionsAction();
    }

    function _checkMarginOptionContractAction(bytes4 selector) internal pure {
        if (
            selector == MarginOptionContract.claim.selector ||
            selector == MarginOptionContract.reclaimWriterMargin.selector
        ) {
            return;
        }

        revert BadMarginOptionLifecycle();
    }

    function _checkBinaryMarginOptionsOrderBookAction(
        address account,
        uint16 riskLevel,
        bytes4 selector
    ) internal view {
        if (
            selector == BinaryMarginOptionsOrderBook.placeOrder.selector ||
            selector == BinaryMarginOptionsOrderBook.acceptOrder.selector
        ) {
            if (!valuationModule.canTrade(account, riskLevel)) revert TradeDisallowed();
            return;
        }

        revert BadBinaryOptionsAction();
    }

    function _checkBinaryMarginOptionContractAction(bytes4 selector) internal pure {
        if (
            selector == BinaryMarginOptionContract.claim.selector ||
            selector == BinaryMarginOptionContract.reclaimWriterMargin.selector
        ) {
            return;
        }

        revert BadBinaryOptionLifecycle();
    }

    function _checkLiquidationEngineAction(
        address account,
        uint16 riskLevel,
        address liquidationEngine,
        bytes4 selector,
        bytes calldata args
    ) internal view {
        if (selector == LiquidationEngine.buyAuctionedAccount.selector) {
            address auctionedAccount = abi.decode(args, (address));

            bool ok = valuationModule.canBuyAuctionedAccount(
                account,
                riskLevel,
                liquidationEngine,
                auctionedAccount
            );

            if (!ok) revert AuctionPurchaseDisallowed();

            return;
        }

        revert BadLiquidationAction();
    }
}
