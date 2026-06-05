// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { TreasuryAuthority } from "./TreasuryAuthority.sol";

/**
 * @title TreasuryModuleBase
 * @notice Shared base contract for treasury execution modules.
 */
abstract contract TreasuryModuleBase {
    TreasuryAuthority public immutable authority;

    error Unauthorized();
    error InvalidAddress();

    constructor(address authority_) {
        if (authority_ == address(0)) revert InvalidAddress();
        authority = TreasuryAuthority(authority_);
    }

    modifier onlyGovernor() {
        if (!authority.hasRole(authority.GOVERNOR_ROLE(), msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyVaultTreasurer() {
        authority.requireTreasurerPermission(msg.sender, authority.PERMISSION_CALL_VAULT());
        _;
    }

    modifier onlyLiquidityTreasurer() {
        authority.requireTreasurerPermission(msg.sender, authority.PERMISSION_MANAGE_LIQUIDITY());
        _;
    }

    modifier onlyPassiveQuotePublisher() {
        authority.requireTreasurerPermission(msg.sender, authority.PERMISSION_PUBLISH_PASSIVE_QUOTES());
        _;
    }

    modifier onlyPaymentsTreasurer() {
        authority.requireTreasurerPermission(msg.sender, authority.PERMISSION_MANAGE_PAYMENTS());
        _;
    }

    modifier onlyTradingTreasurer() {
        authority.requireTreasurerPermission(msg.sender, authority.PERMISSION_TRADE_SETHX());
        _;
    }
}
