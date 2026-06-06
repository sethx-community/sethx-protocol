// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { IChainlinkAggregatorV3 } from "./interfaces/IChainlinkAggregatorV3.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/**
 * @title ChainlinkEthPairOracleBase
 * @notice Immutable Chainlink Data Feed adapter for token/ETH prices.
 * @dev The feed address and staleness limit are immutable after deployment, so a market
 *      registered with this oracle cannot silently be moved to a different price source.
 */
abstract contract ChainlinkEthPairOracleBase is AccessControl, IPriceOracle {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    uint8 public constant OUTPUT_DECIMALS = 18;

    IChainlinkAggregatorV3 public immutable feed;
    uint256 public immutable maxStaleness;
    uint8 internal immutable _feedDecimals;
    string internal _pair;
    string internal _source;
    string internal _notes;

    uint256 private _price;
    uint256 private _priceTimestamp;
    uint256 private _lastFetchTimestamp;
    string private _status;

    event PriceFetched(
        address indexed feed,
        uint80 indexed roundId,
        int256 rawAnswer,
        uint256 normalizedPrice,
        uint256 feedTimestamp,
        uint256 fetchTimestamp
    );
    event FundingTokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidAmount();
    error InvalidFeedAnswer();
    error IncompleteRound();
    error StalePrice();
    error UnsupportedFeedDecimals();

    constructor(
        address admin,
        address feed_,
        uint256 maxStaleness_,
        string memory pair_,
        string memory source_,
        string memory notes_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (feed_ == address(0)) revert ZeroAddress();

        uint8 feedDecimals_ = IChainlinkAggregatorV3(feed_).decimals();
        if (feedDecimals_ > 36) revert UnsupportedFeedDecimals();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);

        feed = IChainlinkAggregatorV3(feed_);
        maxStaleness = maxStaleness_;
        _feedDecimals = feedDecimals_;
        _pair = pair_;
        _source = source_;
        _notes = notes_;
        _status = "PENDING";
    }

    function getLastPrice()
        external
        view
        returns (uint256 price, uint256 timestamp, uint256 lastFetchTimestamp, string memory status)
    {
        return (_price, _priceTimestamp, _lastFetchTimestamp, _status);
    }

    function decimals() external pure returns (uint8) {
        return OUTPUT_DECIMALS;
    }

    function feedDecimals() external view returns (uint8) {
        return _feedDecimals;
    }

    function fetchPrice() external virtual {
        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();

        if (answer <= 0) revert InvalidFeedAnswer();
        if (startedAt == 0 || updatedAt == 0) revert InvalidFeedAnswer();
        if (answeredInRound < roundId) revert IncompleteRound();
        if (maxStaleness != 0 && block.timestamp > updatedAt + maxStaleness) revert StalePrice();

        uint256 normalizedPrice = _normalize(uint256(answer));
        uint256 fetchTimestamp = block.timestamp;

        _setPriceState(normalizedPrice, updatedAt, fetchTimestamp, "OK");

        emit PriceFetched(
            address(feed),
            roundId,
            answer,
            normalizedPrice,
            updatedAt,
            fetchTimestamp
        );
    }

    function fetchFormula() external view virtual returns (string memory) {
        return
            string.concat(
                "// Source: ",
                _pair,
                " from ",
                _source,
                " at ",
                Strings.toHexString(address(feed)),
                "\n",
                "// Formula: price = Chainlink latestRoundData().answer normalized from feed decimals to 18 decimals.\n",
                "// Feed decimals: ",
                Strings.toString(uint256(_feedDecimals)),
                "; output decimals: 18; max staleness seconds: ",
                Strings.toString(maxStaleness),
                "\n\n",
                "IChainlinkAggregatorV3 public immutable feed = IChainlinkAggregatorV3(",
                Strings.toHexString(address(feed)),
                ");\n\n",
                "function fetchPrice() external {\n",
                "    (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();\n",
                "    if (answer <= 0) revert InvalidFeedAnswer();\n",
                "    if (startedAt == 0 || updatedAt == 0) revert InvalidFeedAnswer();\n",
                "    if (answeredInRound < roundId) revert IncompleteRound();\n",
                "    if (maxStaleness != 0 && block.timestamp > updatedAt + maxStaleness) revert StalePrice();\n",
                "    uint256 normalizedPrice = _normalize(uint256(answer));\n",
                "    _price = normalizedPrice;\n",
                "    _priceTimestamp = updatedAt;\n",
                "    _lastFetchTimestamp = block.timestamp;\n",
                '    _status = "OK";\n',
                "}\n\n",
                "function _normalize(uint256 rawPrice) internal view returns (uint256) {\n",
                "    if (_feedDecimals == 18) return rawPrice;\n",
                "    if (_feedDecimals < 18) return rawPrice * (10 ** (18 - _feedDecimals));\n",
                "    return rawPrice / (10 ** (_feedDecimals - 18));\n",
                "}"
            );
    }

    function metadata()
        external
        view
        returns (string memory pair, string memory source, string memory notes)
    {
        return (_pair, _source, _notes);
    }

    function depositFundingToken(address token, uint256 amount) external {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

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

    function _normalize(uint256 rawPrice) internal view returns (uint256) {
        if (_feedDecimals == OUTPUT_DECIMALS) return rawPrice;
        if (_feedDecimals < OUTPUT_DECIMALS)
            return rawPrice * (10 ** (OUTPUT_DECIMALS - _feedDecimals));
        return rawPrice / (10 ** (_feedDecimals - OUTPUT_DECIMALS));
    }

    function _setPriceState(
        uint256 price_,
        uint256 priceTimestamp_,
        uint256 fetchTimestamp_,
        string memory status_
    ) internal {
        _price = price_;
        _priceTimestamp = priceTimestamp_;
        _lastFetchTimestamp = fetchTimestamp_;
        _status = status_;
    }
}
