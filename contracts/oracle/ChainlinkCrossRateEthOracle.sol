// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { ChainlinkEthPairOracleBase } from "./ChainlinkEthPairOracleBase.sol";
import { IChainlinkAggregatorV3 } from "./interfaces/IChainlinkAggregatorV3.sol";

contract ChainlinkCrossRateEthOracle is ChainlinkEthPairOracleBase {
    IChainlinkAggregatorV3 public immutable ethUsdFeed;
    uint8 private immutable _ethUsdDecimals;

    error InvalidEthUsdAnswer();

    constructor(
        address admin,
        address assetUsdFeed_,
        address ethUsdFeed_,
        uint256 maxStaleness_,
        string memory pairName_
    )
        ChainlinkEthPairOracleBase(
            admin,
            assetUsdFeed_,
            maxStaleness_,
            pairName_,
            "Chainlink Cross-Rate Matrix",
            "Combines Asset/USD and ETH/USD feeds to output Asset/ETH scaled to 18 decimals."
        )
    {
        if (ethUsdFeed_ == address(0)) revert ZeroAddress();

        ethUsdFeed = IChainlinkAggregatorV3(ethUsdFeed_);
        _ethUsdDecimals = IChainlinkAggregatorV3(ethUsdFeed_).decimals();

        if (_ethUsdDecimals > 36) revert UnsupportedFeedDecimals();
    }

    function fetchPrice() external override {
        (
            uint80 assetRoundId,
            int256 assetAnswer,
            uint256 assetStartedAt,
            uint256 assetUpdatedAt,
            uint80 assetAnsweredInRound
        ) = feed.latestRoundData();

        if (assetAnswer <= 0) revert InvalidFeedAnswer();
        if (assetStartedAt == 0 || assetUpdatedAt == 0) revert InvalidFeedAnswer();
        if (assetAnsweredInRound < assetRoundId) revert IncompleteRound();
        if (maxStaleness != 0 && block.timestamp > assetUpdatedAt + maxStaleness) {
            revert StalePrice();
        }

        (
            uint80 ethRoundId,
            int256 ethAnswer,
            uint256 ethStartedAt,
            uint256 ethUpdatedAt,
            uint80 ethAnsweredInRound
        ) = ethUsdFeed.latestRoundData();

        if (ethAnswer <= 0) revert InvalidEthUsdAnswer();
        if (ethStartedAt == 0 || ethUpdatedAt == 0) revert InvalidEthUsdAnswer();
        if (ethAnsweredInRound < ethRoundId) revert IncompleteRound();
        if (maxStaleness != 0 && block.timestamp > ethUpdatedAt + maxStaleness) {
            revert StalePrice();
        }

        uint256 assetUsdE18 = _normalizeRaw(uint256(assetAnswer), _feedDecimals);
        uint256 ethUsdE18 = _normalizeRaw(uint256(ethAnswer), _ethUsdDecimals);

        uint256 assetEthE18 = (assetUsdE18 * (10 ** OUTPUT_DECIMALS)) / ethUsdE18;
        uint256 fetchTimestamp = block.timestamp;

        // Use the older source-feed timestamp as the conservative price timestamp.
        uint256 priceTimestamp = assetUpdatedAt < ethUpdatedAt ? assetUpdatedAt : ethUpdatedAt;

        _setPriceState(assetEthE18, priceTimestamp, fetchTimestamp, "OK");

        emit PriceFetched(
            address(feed),
            assetRoundId,
            assetAnswer,
            assetEthE18,
            priceTimestamp,
            fetchTimestamp
        );
    }

    function fetchFormula() external view override returns (string memory) {
        return
            string.concat(
                "// Source: ",
                _pair,
                " from Chainlink cross-rate feeds\n",
                "// Asset/USD feed: ",
                Strings.toHexString(address(feed)),
                "\n",
                "// ETH/USD feed: ",
                Strings.toHexString(address(ethUsdFeed)),
                "\n",
                "// Formula: assetEthE18 = normalize(assetUsdAnswer) * 1e18 / normalize(ethUsdAnswer).\n",
                "// Asset/USD feed decimals: ",
                Strings.toString(uint256(_feedDecimals)),
                "; ETH/USD feed decimals: ",
                Strings.toString(uint256(_ethUsdDecimals)),
                "; output decimals: 18; max staleness seconds: ",
                Strings.toString(maxStaleness)
            );
    }

    function _normalizeRaw(uint256 rawPrice, uint8 sourceDecimals) internal pure returns (uint256) {
        if (sourceDecimals == OUTPUT_DECIMALS) return rawPrice;
        if (sourceDecimals < OUTPUT_DECIMALS) {
            return rawPrice * (10 ** uint256(OUTPUT_DECIMALS - sourceDecimals));
        }
        return rawPrice / (10 ** uint256(sourceDecimals - OUTPUT_DECIMALS));
    }
}
