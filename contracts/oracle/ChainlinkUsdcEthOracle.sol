// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ChainlinkEthPairOracleBase } from "./ChainlinkEthPairOracleBase.sol";

/**
 * @title ChainlinkUsdcEthOracle
 * @notice USDC/ETH oracle backed by one immutable Chainlink AggregatorV3 feed.
 */
contract ChainlinkUsdcEthOracle is ChainlinkEthPairOracleBase {
    constructor(address admin, address feed, uint256 maxStaleness)
        ChainlinkEthPairOracleBase(
            admin,
            feed,
            maxStaleness,
            "USDC/ETH",
            "Chainlink Data Feed",
            "Returns ETH per 1 USDC, normalized to 18 decimals. The feed address is immutable after deployment."
        )
    {}
}
