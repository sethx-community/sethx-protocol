// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ChainlinkEthPairOracleBase } from "./ChainlinkEthPairOracleBase.sol";

/**
 * @title ChainlinkDirectEthPairOracle
 * @notice Concrete adapter for Chainlink feeds that already return Asset/ETH.
 */
contract ChainlinkDirectEthPairOracle is ChainlinkEthPairOracleBase {
    constructor(
        address admin,
        address feed_,
        uint256 maxStaleness_,
        string memory pairName_
    )
        ChainlinkEthPairOracleBase(
            admin,
            feed_,
            maxStaleness_,
            pairName_,
            "Chainlink Data Feed",
            "Returns Asset/ETH from a direct Chainlink ETH pair feed, normalized to 18 decimals."
        )
    {}
}
