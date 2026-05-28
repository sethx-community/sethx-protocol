// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { FuturesContract } from "../futures/FuturesContract.sol";
import { SethxVault } from "../../vault/SethxVault.sol";

contract FuturesValuationAdapter is AccessControl {
    uint256 public constant WAD = 1e18;
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // -------- Errors --------
    error ZeroAddress();

    struct FuturesValue {
        uint256 marginValueEth;
        uint256 multiplier;
    }

    FuturesContract public futures;
    SethxVault public vault;

    event FuturesSet(address indexed futures);

    constructor(address _futures, address _vault, address admin) {
        if (_futures == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        futures = FuturesContract(_futures);
        vault = SethxVault(_vault);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setFutures(address _futures) external onlyRole(GOVERNOR_ROLE) {
        if (_futures == address(0)) revert ZeroAddress();
        futures = FuturesContract(_futures);
        emit FuturesSet(_futures);
    }

    function getValuationData(
        address account
    ) external view returns (FuturesValue[] memory values) {
        bytes32[] memory marketKeys = futures.getMarketKeys();

        // worst case: one long + one short entry per market
        values = new FuturesValue[](marketKeys.length * 2);
        uint256 n = 0;

        for (uint256 i = 0; i < marketKeys.length; i++) {
            bytes32 marketKey = marketKeys[i];
            FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);

            if (m.oracle == address(0)) continue;

            uint256 pxEth;

            pxEth = WAD;

            {
                FuturesContract.Position memory longPos = futures.getPosition(
                    account,
                    marketKey,
                    true
                );

                if (longPos.isActive && longPos.size > 0 && longPos.margin > 0) {
                    values[n] = FuturesValue({
                        marginValueEth: _tokenAmountRawToEth(
                            m.marginDecimals,
                            longPos.margin,
                            pxEth
                        ),
                        multiplier: _normalizeMultiplier(m.multiplier)
                    });
                    unchecked {
                        ++n;
                    }
                }
            }

            {
                FuturesContract.Position memory shortPos = futures.getPosition(
                    account,
                    marketKey,
                    false
                );

                if (shortPos.isActive && shortPos.size > 0 && shortPos.margin > 0) {
                    values[n] = FuturesValue({
                        marginValueEth: _tokenAmountRawToEth(
                            m.marginDecimals,
                            shortPos.margin,
                            pxEth
                        ),
                        multiplier: _normalizeMultiplier(m.multiplier)
                    });
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

    function _tokenAmountRawToEth(
        uint8 tokenDecimals,
        uint256 rawAmount,
        uint256 pxEth
    ) internal pure returns (uint256) {
        if (rawAmount == 0 || pxEth == 0) return 0;
        return (rawAmount * pxEth) / (10 ** uint256(tokenDecimals));
    }

    /// @notice Converts WAD-scaled futures multiplier into an integer bucket for risk haircuts.
    /// @dev Conservative rounding up:
    /// - 1.0x => 1
    /// - 1.2x => 2
    /// - 2.0x => 2
    function _normalizeMultiplier(uint256 multiplierWad) internal pure returns (uint256) {
        if (multiplierWad == 0) return 0;
        return (multiplierWad + WAD - 1) / WAD;
    }
}
