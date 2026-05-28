// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { TreasuryModuleBase } from "./TreasuryModuleBase.sol";
import { ProtocolTreasury } from "./ProtocolTreasury.sol";

/**
 * @title TreasuryPaymentsModule
 * @notice External payment module for protocol treasury.
 *
 * Scope:
 * - external payments leaving the protocol
 * - vendors, service providers, grants, operational expenses
 * - governor approves recipient/token/monthly budget
 * - any payment treasurer can execute within the approved budget
 * - uses ProtocolTreasury as custody source of truth
 *
 * Non-goals:
 * - no internal market deployment
 * - no liquidity allocation
 * - no protocol token trading / buybacks
 */
contract TreasuryPaymentsModule is TreasuryModuleBase {
    uint64 public constant PAYMENT_PERIOD = 30 days;

    ProtocolTreasury public immutable protocolTreasury;

    struct PaymentBudget {
        bool approved;
        uint256 monthlyLimit;
        uint256 spentInPeriod;
        uint64 periodStart;
    }

    /// @notice recipient => token => budget.
    /// @dev token address(0) means ETH.
    mapping(address => mapping(address => PaymentBudget)) public paymentBudgets;

    event PaymentBudgetSet(
        address indexed recipient,
        address indexed token,
        uint256 monthlyLimit,
        bool approved
    );

    event PaymentBudgetConsumed(
        address indexed treasurer,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 spentInPeriod,
        uint64 periodStart,
        string memo
    );

    event ETHPaymentExecuted(
        address indexed treasurer,
        address indexed recipient,
        uint256 amount,
        string memo
    );

    event ERC20PaymentExecuted(
        address indexed treasurer,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        string memo
    );

    error InvalidAmount();
    error EmptyMemo();
    error PaymentBudgetNotApproved();
    error PaymentBudgetExceeded();

    constructor(address authority_, address protocolTreasury_) TreasuryModuleBase(authority_) {
        if (protocolTreasury_ == address(0)) revert InvalidAddress();
        protocolTreasury = ProtocolTreasury(payable(protocolTreasury_));
    }

    /**
     * @notice Governor approves or updates a recipient/token monthly payment budget.
     * @dev Use token address(0) for ETH.
     */
    function setPaymentBudget(
        address recipient,
        address token,
        uint256 monthlyLimit,
        bool approved
    ) external onlyGovernor {
        if (recipient == address(0)) revert InvalidAddress();
        if (approved && monthlyLimit == 0) revert InvalidAmount();

        PaymentBudget storage budget = paymentBudgets[recipient][token];

        budget.approved = approved;
        budget.monthlyLimit = monthlyLimit;

        emit PaymentBudgetSet(recipient, token, monthlyLimit, approved);
    }

    /**
     * @notice Governor can reset the current monthly spend bucket for a recipient/token.
     * @dev Useful after changing a budget or fixing operational mistakes.
     */
    function resetPaymentBudgetPeriod(address recipient, address token) external onlyGovernor {
        if (recipient == address(0)) revert InvalidAddress();

        PaymentBudget storage budget = paymentBudgets[recipient][token];
        budget.periodStart = uint64(block.timestamp);
        budget.spentInPeriod = 0;
    }

    /**
     * @notice Returns the remaining spend capacity for a recipient/token in the current period.
     */
    function getRemainingPaymentBudget(
        address recipient,
        address token
    ) external view returns (uint256 remaining) {
        PaymentBudget memory budget = paymentBudgets[recipient][token];

        if (!budget.approved) return 0;

        uint256 spent = budget.spentInPeriod;

        if (
            budget.periodStart == 0 ||
            block.timestamp >= uint256(budget.periodStart) + PAYMENT_PERIOD
        ) {
            spent = 0;
        }

        if (spent >= budget.monthlyLimit) return 0;
        return budget.monthlyLimit - spent;
    }

    /**
     * @notice Pay ETH to an approved external recipient.
     */
    function payETH(
        address payable recipient,
        uint256 amount,
        string calldata memo
    ) external onlyPaymentsTreasurer {
        if (recipient == payable(address(0))) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (bytes(memo).length == 0) revert EmptyMemo();

        _consumePaymentBudget(recipient, address(0), amount, memo);

        protocolTreasury.payETH(recipient, amount);

        emit ETHPaymentExecuted(msg.sender, recipient, amount, memo);
    }

    /**
     * @notice Pay ERC20 to an approved external recipient.
     */
    function payERC20(
        address token,
        address recipient,
        uint256 amount,
        string calldata memo
    ) external onlyPaymentsTreasurer {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (bytes(memo).length == 0) revert EmptyMemo();

        _consumePaymentBudget(recipient, token, amount, memo);

        protocolTreasury.payERC20(token, recipient, amount);

        emit ERC20PaymentExecuted(msg.sender, token, recipient, amount, memo);
    }

    function _consumePaymentBudget(
        address recipient,
        address token,
        uint256 amount,
        string calldata memo
    ) internal {
        PaymentBudget storage budget = paymentBudgets[recipient][token];

        if (!budget.approved) revert PaymentBudgetNotApproved();

        uint64 currentTime = uint64(block.timestamp);

        if (
            budget.periodStart == 0 ||
            block.timestamp >= uint256(budget.periodStart) + PAYMENT_PERIOD
        ) {
            budget.periodStart = currentTime;
            budget.spentInPeriod = 0;
        }

        if (budget.spentInPeriod + amount > budget.monthlyLimit) {
            revert PaymentBudgetExceeded();
        }

        budget.spentInPeriod += amount;

        emit PaymentBudgetConsumed(
            msg.sender,
            recipient,
            token,
            amount,
            budget.spentInPeriod,
            budget.periodStart,
            memo
        );
    }
}
