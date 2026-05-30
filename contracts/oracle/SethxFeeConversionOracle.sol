// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/**
 * @title SethxFeeConversionOracle
 * @notice Governor-managed oracle for converting ETH-denominated fees into SETHX.
 *
 * Price convention:
 * - returns SETHX per 1 ETH
 * - 18 decimals
 *
 * Example:
 * - if 1 ETH = 20,000 SETHX, price = 20_000e18
 *
 * This oracle is intentionally governance-set, not market-fed.
 * It is intended for fee conversion and treasury/accounting contexts,
 * not for external market pricing or futures settlement.
 */
contract SethxFeeConversionOracle is AccessControl, IPriceOracle {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    uint256 public constant WAD = 1e18;
    uint256 public constant DEFAULT_SETHX_PER_ETH = 20_000 * WAD;

    uint256 public sethxPerEth;
    uint256 public lastRateUpdateTimestamp;
    uint256 public lastFetchTimestamp;

    event SethxPerEthSet(uint256 oldRate, uint256 newRate, uint256 timestamp);
    event FundingTokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidRate();
    error InvalidAmount();

    constructor(address admin, uint256 initialSethxPerEth) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialSethxPerEth == 0) revert InvalidRate();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);

        sethxPerEth = initialSethxPerEth;
        lastRateUpdateTimestamp = block.timestamp;
        lastFetchTimestamp = block.timestamp;

        emit SethxPerEthSet(0, initialSethxPerEth, block.timestamp);
    }

    function setSethxPerEth(uint256 newSethxPerEth) external onlyRole(GOVERNOR_ROLE) {
        if (newSethxPerEth == 0) revert InvalidRate();

        uint256 oldRate = sethxPerEth;

        sethxPerEth = newSethxPerEth;
        lastRateUpdateTimestamp = block.timestamp;
        lastFetchTimestamp = block.timestamp;

        emit SethxPerEthSet(oldRate, newSethxPerEth, block.timestamp);
    }

    function getLastPrice()
        external
        view
        returns (uint256 price, uint256 timestamp, uint256 fetchTimestamp, string memory status)
    {
        return (sethxPerEth, lastRateUpdateTimestamp, lastFetchTimestamp, "OK");
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function fetchPrice() external {
        lastFetchTimestamp = block.timestamp;
    }

    function fetchFormula() external pure returns (string memory) {
        return "Governance-set fixed conversion: price = sethxPerEth, scaled to 18 decimals as SETHX per 1 ETH. fetchPrice() records lastFetchTimestamp; setSethxPerEth() updates the stored price.";
    }

    function metadata()
        external
        pure
        returns (string memory pair, string memory source, string memory notes)
    {
        return (
            "SETHX/ETH",
            "Governor fixed fee conversion",
            "Returns SETHX per 1 ETH for SETHX fee conversion"
        );
    }

    /**
     * @notice No-op for interface compatibility.
     * @dev This oracle does not require funding tokens.
     */
    function depositFundingToken(address token, uint256 amount) external {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Withdraw accidentally deposited or interface-compatible funding tokens.
     * @dev Restricted to governor because this oracle should not normally hold funding tokens.
     */
    function withdrawFundingToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(GOVERNOR_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransfer(to, amount);

        emit FundingTokenWithdrawn(token, to, amount);
    }

    function fundingTokenBalance(address token) external view returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        return IERC20(token).balanceOf(address(this));
    }
}
