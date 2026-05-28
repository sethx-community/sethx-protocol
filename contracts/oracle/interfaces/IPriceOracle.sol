// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPriceOracle {
    /// @notice Gets the last price and related metadata.
    function getLastPrice()
        external
        view
        returns (
            uint256 price,
            uint256 timestamp,
            uint256 lastFetchTimestamp,
            string memory status
        );

    /// @notice Returns number of decimals the price is scaled by.
    function decimals() external view returns (uint8);

    /// @notice Triggers a price update.
    function fetchPrice(bytes calldata data) external;

    /// @notice Returns metadata for display/exploration.
    function metadata()
        external
        view
        returns (string memory pair, string memory source, string memory notes);

    /// @notice Deposits a funding token into the oracle contract.
    /// @dev Used for oracle providers that require LINK or other request/payment tokens.
    function depositFundingToken(address token, uint256 amount) external;

    /// @notice Withdraws a funding token from the oracle contract.
    /// @dev Should be restricted inside the oracle implementation.
    function withdrawFundingToken(address token, address to, uint256 amount) external;

    /// @notice Returns the oracle contract's funding token balance.
    function fundingTokenBalance(address token) external view returns (uint256);
}
