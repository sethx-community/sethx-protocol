// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Account } from "./Account.sol";
import { AccountRegistry } from "./AccountRegistry.sol";

contract AccountFactory {
    address public immutable registry;
    address public immutable vault;

    // -------- Errors --------
    error ZeroAddress();

    event AccountCreated(address indexed user, address indexed account);

    constructor(address _registry, address _vault) {
        if (_registry == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();

        registry = _registry;
        vault = _vault;
    }

    function createAccount() external returns (address account) {
        account = address(new Account(msg.sender, vault, registry));

        AccountRegistry(registry).registerAccount(msg.sender, account);

        emit AccountCreated(msg.sender, account);
    }
}
