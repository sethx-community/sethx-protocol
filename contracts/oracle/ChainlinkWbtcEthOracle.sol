// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ChainlinkEthPairOracleBase } from "./ChainlinkEthPairOracleBase.sol";

/**
 * @title ChainlinkWbtcEthOracle
 * @notice WBTC/ETH oracle backed by one immutable Chainlink AggregatorV3 feed.
 */
contract ChainlinkWbtcEthOracle is ChainlinkEthPairOracleBase {
    constructor(address admin, address feed, uint256 maxStaleness)
        ChainlinkEthPairOracleBase(
            admin,
            feed,
            maxStaleness,
            "WBTC/ETH",
            "Chainlink Data Feed",
            "Returns ETH per 1 WBTC/BTC, normalized to 18 decimals. The feed address is immutable after deployment."
        )
    {}
}
