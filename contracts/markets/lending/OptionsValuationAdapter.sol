// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { PriceManager } from "../../oracle/PriceManager.sol";
import { OptionContract } from "../options/OptionContract.sol";
import { MarginOptionContract } from "../margin/MarginOptionContract.sol";
import { BinaryMarginOptionContract } from "../margin/BinaryMarginOptionContract.sol";

contract OptionsValuationAdapter is AccessControl {
    uint256 public constant WAD = 1e18;
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // -------- Errors --------
    error ZeroAddress();

    struct OptionValue {
        uint256 longIntrinsicValueEth;
        uint256 shortCoveredPositiveRemainderEth;
        bool isBinary;
    }

    PriceManager public priceManager;
    OptionContract public vanillaOptions;
    MarginOptionContract public marginOptions;
    BinaryMarginOptionContract public binaryMarginOptions;

    event PriceManagerSet(address indexed priceManager);
    event VanillaOptionsSet(address indexed vanillaOptions);
    event MarginOptionsSet(address indexed marginOptions);
    event BinaryMarginOptionsSet(address indexed binaryMarginOptions);

    constructor(
        address _priceManager,
        address _vanillaOptions,
        address _marginOptions,
        address _binaryMarginOptions,
        address admin
    ) {
        if (_priceManager == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);

        priceManager = PriceManager(_priceManager);
        vanillaOptions = OptionContract(_vanillaOptions);
        marginOptions = MarginOptionContract(_marginOptions);
        binaryMarginOptions = BinaryMarginOptionContract(_binaryMarginOptions);
    }

    function setPriceManager(address _priceManager) external onlyRole(GOVERNOR_ROLE) {
        if (_priceManager == address(0)) revert ZeroAddress();
        priceManager = PriceManager(_priceManager);
        emit PriceManagerSet(_priceManager);
    }

    function setVanillaOptions(address _vanillaOptions) external onlyRole(GOVERNOR_ROLE) {
        vanillaOptions = OptionContract(_vanillaOptions);
        emit VanillaOptionsSet(_vanillaOptions);
    }

    function setMarginOptions(address _marginOptions) external onlyRole(GOVERNOR_ROLE) {
        marginOptions = MarginOptionContract(_marginOptions);
        emit MarginOptionsSet(_marginOptions);
    }

    function setBinaryMarginOptions(address _binaryMarginOptions) external onlyRole(GOVERNOR_ROLE) {
        binaryMarginOptions = BinaryMarginOptionContract(_binaryMarginOptions);
        emit BinaryMarginOptionsSet(_binaryMarginOptions);
    }

    function getValuationData(address account) external view returns (OptionValue[] memory values) {
        uint256 vanillaCount =
            address(vanillaOptions) == address(0) ? 0 : vanillaOptions.getUserMarketsCount(account);

        uint256 marginCount = 0;
        bytes32[] memory marginKeys;
        if (address(marginOptions) != address(0)) {
            marginKeys = marginOptions.getMarketKeys();
            marginCount = marginKeys.length;
        }

        uint256 binaryCount = 0;
        bytes32[] memory binaryKeys;
        if (address(binaryMarginOptions) != address(0)) {
            binaryKeys = binaryMarginOptions.getMarketKeys();
            binaryCount = binaryKeys.length;
        }

        values = new OptionValue[](vanillaCount + marginCount + binaryCount);
        uint256 n = 0;

        if (address(vanillaOptions) != address(0) && vanillaCount > 0) {
            bytes32[] memory userMarkets = vanillaOptions.getUserMarketsPaged(
                account,
                0,
                vanillaCount
            );

            for (uint256 i = 0; i < userMarkets.length; i++) {
                OptionValue memory v = _getVanillaValue(account, userMarkets[i]);
                if (
                    v.longIntrinsicValueEth > 0 ||
                    v.shortCoveredPositiveRemainderEth > 0 ||
                    v.isBinary
                ) {
                    values[n] = v;
                    unchecked {
                        ++n;
                    }
                }
            }
        }

        if (address(marginOptions) != address(0)) {
            for (uint256 i = 0; i < marginKeys.length; i++) {
                OptionValue memory v = _getMarginValue(account, marginKeys[i]);
                if (
                    v.longIntrinsicValueEth > 0 ||
                    v.shortCoveredPositiveRemainderEth > 0 ||
                    v.isBinary
                ) {
                    values[n] = v;
                    unchecked {
                        ++n;
                    }
                }
            }
        }

        if (address(binaryMarginOptions) != address(0)) {
            for (uint256 i = 0; i < binaryKeys.length; i++) {
                OptionValue memory v = _getBinaryValue(account, binaryKeys[i]);
                if (
                    v.longIntrinsicValueEth > 0 ||
                    v.shortCoveredPositiveRemainderEth > 0 ||
                    v.isBinary
                ) {
                    values[n] = v;
                    unchecked {
                        ++n;
                    }
                }
            }
        }

        assembly {
            mstore(values, n)
        }
    }

    function _getVanillaValue(
        address account,
        bytes32 marketKey
    ) internal view returns (OptionValue memory v) {
        (
            bool initialized,
            OptionContract.OptionType optionType,
            address assetToken,
            address paymentToken,
            uint256 strikePrice,
            uint256 expiry,
            ,
            ,
            ,

        ) = vanillaOptions.getMarket(marketKey);

        if (!initialized) return v;

        (uint256 writerSize, uint256 holderSize, uint256 holderExercised) = vanillaOptions
            .getUserPosition(marketKey, account);

        uint256 holderRemaining = holderSize > holderExercised ? holderSize - holderExercised : 0;
        if (holderRemaining == 0 && writerSize == 0) return v;

        uint256 spotQuoteRawPerAsset = _getSpotInQuoteRawPerWholeAsset(assetToken, paymentToken);
        if (spotQuoteRawPerAsset == 0) {
            return v;
        }

        uint256 intrinsicPerUnitRaw;
        if (optionType == OptionContract.OptionType.Call) {
            intrinsicPerUnitRaw =
                spotQuoteRawPerAsset > strikePrice ? spotQuoteRawPerAsset - strikePrice : 0;
        } else {
            intrinsicPerUnitRaw =
                strikePrice > spotQuoteRawPerAsset ? strikePrice - spotQuoteRawPerAsset : 0;
        }

        if (holderRemaining > 0 && intrinsicPerUnitRaw > 0) {
            uint256 holderIntrinsicRaw = _mulDivDown(holderRemaining, intrinsicPerUnitRaw, WAD);
            v.longIntrinsicValueEth = _tokenAmountRawToEth(paymentToken, holderIntrinsicRaw);
        }

        // Conservative short valuation:
        // before expiry, recognize only the covered positive remainder;
        // after expiry, return 0 to avoid over-crediting because the vanilla contract
        // does not expose writer exercised amounts in a public getter.
        if (writerSize > 0 && block.timestamp < expiry) {
            uint256 remainderPerUnitRaw;
            if (optionType == OptionContract.OptionType.Call) {
                remainderPerUnitRaw =
                    spotQuoteRawPerAsset < strikePrice ? spotQuoteRawPerAsset : strikePrice;
            } else {
                remainderPerUnitRaw =
                    spotQuoteRawPerAsset < strikePrice ? spotQuoteRawPerAsset : strikePrice;
            }

            if (remainderPerUnitRaw > 0) {
                uint256 remainderRaw = _mulDivDown(writerSize, remainderPerUnitRaw, WAD);
                v.shortCoveredPositiveRemainderEth = _tokenAmountRawToEth(
                    paymentToken,
                    remainderRaw
                );
            }
        }
    }

    function _getMarginValue(
        address account,
        bytes32 marketKey
    ) internal view returns (OptionValue memory v) {
        MarginOptionContract.MarketConfig memory m = marginOptions.getMarket(marketKey);
        if (!m.initialized) return v;

        (uint256 holderSize, uint256 holderClaimed, ) = marginOptions.holders(marketKey, account);
        (uint256 writerSize, , uint256 lockedMargin, uint256 paidOut, ) = marginOptions.writers(
            marketKey,
            account
        );

        uint256 holderRemaining = holderSize > holderClaimed ? holderSize - holderClaimed : 0;
        if (holderRemaining == 0 && writerSize == 0) return v;

        uint256 payoutPerUnitRaw = _getMarginPayoutPerUnitRaw(m);
        if (holderRemaining > 0 && payoutPerUnitRaw > 0) {
            uint256 payoutRaw = _mulDivDown(holderRemaining, payoutPerUnitRaw, WAD);
            v.longIntrinsicValueEth = _tokenAmountRawToEth(m.paymentToken, payoutRaw);
        }

        if (writerSize > 0) {
            uint256 availableMarginRaw = lockedMargin > paidOut ? lockedMargin - paidOut : 0;
            if (availableMarginRaw > 0) {
                v.shortCoveredPositiveRemainderEth = _tokenAmountRawToEth(
                    m.paymentToken,
                    availableMarginRaw
                );
            }
        }
    }

    function _getBinaryValue(
        address account,
        bytes32 marketKey
    ) internal view returns (OptionValue memory v) {
        BinaryMarginOptionContract.MarketConfig memory m = binaryMarginOptions.getMarket(marketKey);
        if (!m.initialized) return v;

        (uint256 payoutBought, uint256 payoutClaimed) = binaryMarginOptions.holders(
            marketKey,
            account
        );
        (, , uint256 lockedMargin, uint256 paidOut) = binaryMarginOptions.writers(
            marketKey,
            account
        );

        bool hasLong = payoutBought > payoutClaimed;
        bool hasShort = lockedMargin > paidOut;

        if (!hasLong && !hasShort) return v;

        v.isBinary = true;
        v.longIntrinsicValueEth = 0;
        v.shortCoveredPositiveRemainderEth = 0;
    }

    function _getMarginPayoutPerUnitRaw(
        MarginOptionContract.MarketConfig memory m
    ) internal view returns (uint256) {
        uint256 referencePrice = m.settled ? m.settlementPrice : _getCurrentMarginSpotRaw(m);
        if (referencePrice == 0) return 0;

        uint256 intrinsicRaw;
        if (m.optionType == MarginOptionContract.OptionType.Call) {
            intrinsicRaw = referencePrice > m.strikePrice ? referencePrice - m.strikePrice : 0;
        } else {
            intrinsicRaw = m.strikePrice > referencePrice ? m.strikePrice - referencePrice : 0;
        }

        uint256 capPerUnitRaw = _requiredMarginPerUnitRaw(m);
        return intrinsicRaw < capPerUnitRaw ? intrinsicRaw : capPerUnitRaw;
    }

    function _requiredMarginPerUnitRaw(
        MarginOptionContract.MarketConfig memory m
    ) internal pure returns (uint256) {
        return _mulDivDown(m.strikePrice, m.collateralBps, 10_000);
    }

    function _getCurrentMarginSpotRaw(
        MarginOptionContract.MarketConfig memory m
    ) internal view returns (uint256) {
        if (
            !priceManager.isOracleUsableForContext(
                m.oracle,
                PriceManager.OracleContext.OPTION_SETTLEMENT
            )
        ) {
            return 0;
        }

        (uint256 rawPrice, , , ) = priceManager.getOraclePrice(
            m.oracle,
            PriceManager.OracleContext.OPTION_SETTLEMENT
        );

        if (rawPrice == 0) return 0;

        return _normalizePrice(rawPrice, m.oraclePriceDecimals, m.paymentTokenDecimals);
    }

    function _getSpotInQuoteRawPerWholeAsset(
        address assetToken,
        address paymentToken
    ) internal view returns (uint256) {
        PriceManager.OracleContext ctx = PriceManager.OracleContext.COLLATERAL_EVAL;

        (bool assetOk, address assetOracle) = priceManager.getUsableOracleForTokenContext(
            assetToken,
            ctx
        );

        (bool quoteOk, address quoteOracle) = priceManager.getUsableOracleForTokenContext(
            paymentToken,
            ctx
        );

        if (!assetOk || !quoteOk) return 0;

        uint256 assetPxEth = _oraclePriceInEth(assetOracle, ctx);
        uint256 quotePxEth = _oraclePriceInEth(quoteOracle, ctx);

        if (assetPxEth == 0 || quotePxEth == 0) return 0;

        uint8 quoteDec = _tokenDecimals(paymentToken);

        return (assetPxEth * (10 ** uint256(quoteDec))) / quotePxEth;
    }

    function _tokenAmountRawToEth(
        address token,
        uint256 rawAmount
    ) internal view returns (uint256) {
        if (rawAmount == 0) return 0;

        PriceManager.OracleContext ctx = PriceManager.OracleContext.COLLATERAL_EVAL;

        (bool ok, address oracle) = priceManager.getUsableOracleForTokenContext(token, ctx);
        if (!ok) return 0;

        uint256 pxEth = _oraclePriceInEth(oracle, ctx);
        if (pxEth == 0) return 0;

        uint8 dec = _tokenDecimals(token);

        return _mulDivDown(rawAmount, pxEth, 10 ** uint256(dec));
    }

    function _oraclePriceInEth(
        address oracle,
        PriceManager.OracleContext context
    ) internal view returns (uint256) {
        if (!priceManager.isOracleUsableForContext(oracle, context)) return 0;

        (uint256 rawPrice, uint8 decimals, , ) = priceManager.getOraclePrice(oracle, context);

        if (rawPrice == 0) return 0;

        if (decimals == 18) return rawPrice;
        if (decimals < 18) return rawPrice * (10 ** uint256(18 - decimals));

        return rawPrice / (10 ** uint256(decimals - 18));
    }

    function _tokenDecimals(address token) internal view returns (uint8) {
        if (token == address(0)) return 18;
        return IERC20Metadata(token).decimals();
    }

    function _normalizePrice(
        uint256 rawPrice,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256) {
        if (rawPrice == 0) return 0;
        if (fromDecimals == toDecimals) return rawPrice;
        if (fromDecimals < toDecimals) {
            return rawPrice * (10 ** uint256(toDecimals - fromDecimals));
        }
        return rawPrice / (10 ** uint256(fromDecimals - toDecimals));
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 0;
        return (a * b) / d;
    }
}
