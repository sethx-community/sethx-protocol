// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { PriceManager } from "./PriceManager.sol";

contract FeeManager is AccessControl {
    error ZeroAddress();
    error Unauthorized();
    error InvalidBps();
    error NoPendingUpdate();
    error FeeUpdateTooEarly();
    error UnsupportedFeeToken();
    error InvalidFeeUpdateDelay();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS = 10_000;

    modifier onlyGovernance() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    struct RoleFeeConfig {
        uint256 makerFixedFee;
        uint256 makerPercentageFee;
        uint256 takerFixedFee;
        uint256 takerPercentageFee;
        bool configured;
    }

    struct FeeOutput {
        uint256 fixedAmount;
        address fixedToken;
        uint256 percentageAmount;
        address percentageToken;
    }

    struct PendingRoleFeeUpdate {
        uint256 makerFixedFee;
        uint256 makerPercentageFee;
        uint256 takerFixedFee;
        uint256 takerPercentageFee;
        uint256 executeAfter;
    }

    mapping(string => RoleFeeConfig) public roleFeeConfigs;
    mapping(string => PendingRoleFeeUpdate) public pendingRoleUpdates;
    mapping(address => bool) public isAcceptedFeeToken;
    mapping(address => uint256) public accountDiscountBps;
    address[] public acceptedPaymentTokens;

    uint256 public sethxDiscountBps;
    address public immutable sethxToken;
    PriceManager public priceManager;
    uint256 public feeUpdateDelay;

    event AcceptedFeeTokenUpdated(address token, bool accepted);
    event SethxDiscountSet(uint256 discountBps);
    event AccountDiscountSet(address indexed account, uint256 discountBps);
    event RoleFeeConfigSet(
        string context,
        uint256 makerFixedFee,
        uint256 makerPercentageFee,
        uint256 takerFixedFee,
        uint256 takerPercentageFee
    );
    event RoleFeeUpdateQueued(
        string context,
        uint256 makerFixedFee,
        uint256 makerPercentageFee,
        uint256 takerFixedFee,
        uint256 takerPercentageFee,
        uint256 executeAfter
    );
    event RoleFeeUpdateCancelled(string context);

    event PriceManagerUpdated(address indexed oldPriceManager, address indexed newPriceManager);
    event FeeUpdateDelaySet(uint256 oldDelay, uint256 newDelay);

    constructor(address _sethxToken, address _priceManager, address admin) {
        if (_sethxToken == address(0)) revert ZeroAddress();
        if (_priceManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        sethxToken = _sethxToken;
        priceManager = PriceManager(_priceManager);
        feeUpdateDelay = 1 days;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setPriceManager(address newPriceManager) external onlyGovernance {
        if (newPriceManager == address(0)) revert ZeroAddress();

        address oldPriceManager = address(priceManager);
        priceManager = PriceManager(newPriceManager);

        emit PriceManagerUpdated(oldPriceManager, newPriceManager);
    }

    function setFeeUpdateDelay(uint256 newDelay) external onlyGovernance {
        if (newDelay == 0) revert InvalidFeeUpdateDelay();

        uint256 oldDelay = feeUpdateDelay;
        feeUpdateDelay = newDelay;

        emit FeeUpdateDelaySet(oldDelay, newDelay);
    }

    function setAcceptedFeeToken(address token, bool accepted) external onlyGovernance {
        if (token == address(0)) revert ZeroAddress();
        _setAcceptedFeeToken(token, accepted);
    }

    function setETHAsAcceptedFeeToken(bool accepted) external onlyGovernance {
        _setAcceptedFeeToken(address(0), accepted);
    }

    function _setAcceptedFeeToken(address token, bool accepted) internal {
        isAcceptedFeeToken[token] = accepted;

        bool found = false;
        for (uint256 i = 0; i < acceptedPaymentTokens.length; i++) {
            if (acceptedPaymentTokens[i] == token) {
                found = true;
                if (!accepted) {
                    acceptedPaymentTokens[i] = acceptedPaymentTokens[
                        acceptedPaymentTokens.length - 1
                    ];
                    acceptedPaymentTokens.pop();
                }
                break;
            }
        }

        if (accepted && !found) {
            acceptedPaymentTokens.push(token);
        }

        emit AcceptedFeeTokenUpdated(token, accepted);
    }

    function getAcceptedPaymentTokens() external view returns (address[] memory) {
        return acceptedPaymentTokens;
    }

    function setSethxDiscount(uint256 discountBps) external onlyGovernance {
        if (discountBps > BPS_DENOMINATOR) revert InvalidBps();
        sethxDiscountBps = discountBps;
        emit SethxDiscountSet(discountBps);
    }

    function setAccountDiscount(address account, uint256 discountBps) external onlyGovernance {
        if (account == address(0)) revert ZeroAddress();
        if (discountBps > BPS_DENOMINATOR) revert InvalidBps();
        accountDiscountBps[account] = discountBps;
        emit AccountDiscountSet(account, discountBps);
    }

    function queueRoleFeeUpdate(
        string calldata context,
        uint256 makerFixedFee,
        uint256 makerPercentageFee,
        uint256 takerFixedFee,
        uint256 takerPercentageFee
    ) external onlyGovernance {
        if (makerPercentageFee > MAX_FEE_BPS || takerPercentageFee > MAX_FEE_BPS) {
            revert InvalidBps();
        }

        pendingRoleUpdates[context] = PendingRoleFeeUpdate({
            makerFixedFee: makerFixedFee,
            makerPercentageFee: makerPercentageFee,
            takerFixedFee: takerFixedFee,
            takerPercentageFee: takerPercentageFee,
            executeAfter: block.timestamp + feeUpdateDelay
        });

        emit RoleFeeUpdateQueued(
            context,
            makerFixedFee,
            makerPercentageFee,
            takerFixedFee,
            takerPercentageFee,
            block.timestamp + feeUpdateDelay
        );
    }

    function executeRoleFeeUpdate(string calldata context) external onlyGovernance {
        PendingRoleFeeUpdate memory pending = pendingRoleUpdates[context];
        if (pending.executeAfter == 0) revert NoPendingUpdate();
        if (block.timestamp < pending.executeAfter) revert FeeUpdateTooEarly();

        roleFeeConfigs[context] = RoleFeeConfig({
            makerFixedFee: pending.makerFixedFee,
            makerPercentageFee: pending.makerPercentageFee,
            takerFixedFee: pending.takerFixedFee,
            takerPercentageFee: pending.takerPercentageFee,
            configured: true
        });
        delete pendingRoleUpdates[context];

        emit RoleFeeConfigSet(
            context,
            pending.makerFixedFee,
            pending.makerPercentageFee,
            pending.takerFixedFee,
            pending.takerPercentageFee
        );
    }

    function cancelRoleFeeUpdate(string calldata context) external onlyGovernance {
        delete pendingRoleUpdates[context];
        emit RoleFeeUpdateCancelled(context);
    }

    function getFeeForAccount(
        address paymentToken,
        address assetToken,
        uint256 assetValue,
        string calldata context,
        address account,
        bool isMaker
    ) external view returns (FeeOutput memory fee) {
        return _getFee(paymentToken, assetToken, assetValue, context, account, isMaker);
    }

    function _getFee(
        address paymentToken,
        address assetToken,
        uint256 assetValue,
        string calldata context,
        address account,
        bool isMaker
    ) internal view returns (FeeOutput memory fee) {
        (uint256 fixedFee, uint256 percentageFee) = _roleConfig(context, isMaker);

        if (!isAcceptedFeeToken[paymentToken]) revert UnsupportedFeeToken();

        if (paymentToken == sethxToken) {
            fee.fixedAmount = priceManager.convertEthFeeToToken(paymentToken, fixedFee);
            fee.fixedToken = paymentToken;
        } else {
            fee.fixedAmount = fixedFee;
            fee.fixedToken = paymentToken;
        }

        (bool isAssetTokenUsable, address assetOracle) = priceManager
            .getUsableOracleForTokenContext(assetToken, PriceManager.OracleContext.TRADE_VALUE);

        (bool isPaymentTokenUsable, address paymentOracle) = priceManager
            .getUsableOracleForTokenContext(paymentToken, PriceManager.OracleContext.TRADE_VALUE);

        if (isAssetTokenUsable && isPaymentTokenUsable) {
            uint256 baseValue = priceManager.getConvertedValue(
                assetOracle,
                assetValue,
                paymentOracle
            );

            fee.percentageAmount = (baseValue * percentageFee) / BPS_DENOMINATOR;
            fee.percentageToken = paymentToken;
        } else {
            uint256 rawPercentageAmount = (assetValue * percentageFee) / BPS_DENOMINATOR;
            if (paymentToken == sethxToken && assetToken == address(0)) {
                fee.percentageAmount = priceManager.convertEthFeeToToken(
                    paymentToken,
                    rawPercentageAmount
                );
                fee.percentageToken = paymentToken;
            } else {
                fee.percentageAmount = rawPercentageAmount;
                fee.percentageToken = assetToken;
            }
        }

        _applyDiscounts(fee, account);
        return fee;
    }

    function _roleConfig(
        string calldata context,
        bool isMaker
    ) internal view returns (uint256 fixedFee, uint256 percentageFee) {
        RoleFeeConfig memory roleConfig = roleFeeConfigs[context];
        if (!roleConfig.configured) return (0, 0);
        if (isMaker) return (roleConfig.makerFixedFee, roleConfig.makerPercentageFee);
        return (roleConfig.takerFixedFee, roleConfig.takerPercentageFee);
    }

    function _applyDiscounts(FeeOutput memory fee, address account) internal view {
        if (fee.fixedToken == sethxToken && sethxDiscountBps > 0) {
            fee.fixedAmount =
                (fee.fixedAmount * (BPS_DENOMINATOR - sethxDiscountBps)) / BPS_DENOMINATOR;
        }
        if (fee.percentageToken == sethxToken && sethxDiscountBps > 0) {
            fee.percentageAmount =
                (fee.percentageAmount * (BPS_DENOMINATOR - sethxDiscountBps)) / BPS_DENOMINATOR;
        }

        uint256 accountDiscount = account == address(0) ? 0 : accountDiscountBps[account];
        if (accountDiscount > 0) {
            fee.fixedAmount =
                (fee.fixedAmount * (BPS_DENOMINATOR - accountDiscount)) / BPS_DENOMINATOR;
            fee.percentageAmount =
                (fee.percentageAmount * (BPS_DENOMINATOR - accountDiscount)) / BPS_DENOMINATOR;
        }
    }

    function getRoleFeeConfig(
        string calldata context
    )
        external
        view
        returns (
            uint256 makerFixedFee,
            uint256 makerPercentageFee,
            uint256 takerFixedFee,
            uint256 takerPercentageFee,
            bool configured
        )
    {
        RoleFeeConfig memory config = roleFeeConfigs[context];
        return (
            config.makerFixedFee,
            config.makerPercentageFee,
            config.takerFixedFee,
            config.takerPercentageFee,
            config.configured
        );
    }
}
