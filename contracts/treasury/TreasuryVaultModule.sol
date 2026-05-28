// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { TreasuryModuleBase } from "./TreasuryModuleBase.sol";
import { SethxVault } from "../vault/SethxVault.sol";

/**
 * @title TreasuryVaultModule
 * @notice Treasury module for interacting with SethxVault.
 *
 * This module is an execution adapter only.
 * It does not custody protocol assets itself.
 *
 * Responsibilities:
 * - pull treasury ETH from the vault into ProtocolTreasury
 * - pull treasury ERC20 from the vault into ProtocolTreasury
 *
 * Non-goals:
 * - no vault deposits
 * - no settlement funding
 * - no credit grants
 * - no external payments
 * - no trading logic
 */
contract TreasuryVaultModule is TreasuryModuleBase {
    SethxVault public immutable vault;

    event VaultETHPulled(address indexed treasurer, uint256 amount);
    event VaultERC20Pulled(address indexed treasurer, address indexed token, uint256 amount);

    error InvalidAmount();

    constructor(address authority_, address vault_) TreasuryModuleBase(authority_) {
        if (vault_ == address(0)) revert InvalidAddress();
        vault = SethxVault(vault_);
    }

    /**
     * @notice Pull ETH from vault treasury accounting into vault.protocolTreasury().
     *
     * Requirements:
     * - caller must have vault-treasurer permission in TreasuryAuthority
     * - this module must have TREASURY_ROLE in SethxVault
     * - SethxVault.protocolTreasury must be configured
     */
    function pullTreasuryETHFromVault(uint256 amount) external onlyVaultTreasurer {
        if (amount == 0) revert InvalidAmount();

        vault.withdrawTreasuryETH(amount);

        emit VaultETHPulled(msg.sender, amount);
    }

    /**
     * @notice Pull ERC20 from vault treasury accounting into vault.protocolTreasury().
     *
     * Requirements:
     * - caller must have vault-treasurer permission in TreasuryAuthority
     * - this module must have TREASURY_ROLE in SethxVault
     * - SethxVault.protocolTreasury must be configured
     */
    function pullTreasuryERC20FromVault(address token, uint256 amount) external onlyVaultTreasurer {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        vault.withdrawTreasuryERC20(token, amount);

        emit VaultERC20Pulled(msg.sender, token, amount);
    }
}
