// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

contract AccountRegistry is AccessControl {
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");
    bytes32 public constant TRANSFER_ROLE = keccak256("TRANSFER_ROLE");

    error ZeroAddress();
    error AlreadyRegistered();
    error OwnerAlreadySet();
    error UnknownAccount();
    error SameOwner();
    error AccountNotOwned();

    mapping(address account => bool registered) private _registeredAccounts;
    mapping(address account => bool active) private _activeAccounts;

    mapping(address account => bool registered) private _registeredLendingAccounts;
    mapping(address account => bool active) private _activeLendingAccounts;

    mapping(address account => address owner) public ownerOfAccount;

    mapping(address owner => address[] accounts) private _userToAccounts;
    mapping(address owner => address[] accounts) private _userToLendingAccounts;
    mapping(address owner => address[] accounts) private _userToAllAccounts;

    event AccountRegistered(address indexed user, address indexed account);
    event LendingAccountRegistered(address indexed user, address indexed account);

    event AccountOwnerTransferred(
        address indexed account,
        address indexed oldOwner,
        address indexed newOwner
    );

    event AccountStatusUpdated(address indexed account, bool active);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function registerAccount(address user, address account) external onlyRole(FACTORY_ROLE) {
        if (user == address(0) || account == address(0)) revert ZeroAddress();
        if (_registeredAccounts[account]) revert AlreadyRegistered();
        if (_registeredLendingAccounts[account]) revert AlreadyRegistered();
        if (ownerOfAccount[account] != address(0)) revert OwnerAlreadySet();

        _registeredAccounts[account] = true;
        _activeAccounts[account] = true;
        ownerOfAccount[account] = user;

        _userToAccounts[user].push(account);
        _userToAllAccounts[user].push(account);

        emit AccountRegistered(user, account);
    }

    function registerLendingAccount(address user, address account) external onlyRole(FACTORY_ROLE) {
        if (user == address(0) || account == address(0)) revert ZeroAddress();
        if (_registeredAccounts[account]) revert AlreadyRegistered();
        if (_registeredLendingAccounts[account]) revert AlreadyRegistered();
        if (ownerOfAccount[account] != address(0)) revert OwnerAlreadySet();

        _registeredLendingAccounts[account] = true;
        _activeLendingAccounts[account] = true;
        ownerOfAccount[account] = user;

        _userToLendingAccounts[user].push(account);
        _userToAllAccounts[user].push(account);

        emit LendingAccountRegistered(user, account);
    }

    function transferAccountOwner(address account, address newOwner) external {
        if (account == address(0) || newOwner == address(0)) {
            revert ZeroAddress();
        }

        // Normal ownership transfers are initiated by the registered Account
        // itself after its pending owner accepts. Operational transfers, such
        // as lending-account liquidation, still require TRANSFER_ROLE.
        if (msg.sender != account) {
            _checkRole(TRANSFER_ROLE);
        }

        address oldOwner = ownerOfAccount[account];

        if (oldOwner == address(0)) revert UnknownAccount();
        if (oldOwner == newOwner) revert SameOwner();

        ownerOfAccount[account] = newOwner;

        _removeFromArray(_userToAllAccounts[oldOwner], account);
        _userToAllAccounts[newOwner].push(account);

        if (_registeredAccounts[account]) {
            _removeFromArray(_userToAccounts[oldOwner], account);
            _userToAccounts[newOwner].push(account);
        }

        if (_registeredLendingAccounts[account]) {
            _removeFromArray(_userToLendingAccounts[oldOwner], account);
            _userToLendingAccounts[newOwner].push(account);
        }

        emit AccountOwnerTransferred(account, oldOwner, newOwner);
    }

    function setAccountActive(address account, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();

        bool known;

        if (_registeredAccounts[account]) {
            _activeAccounts[account] = active;
            known = true;
        }

        if (_registeredLendingAccounts[account]) {
            _activeLendingAccounts[account] = active;
            known = true;
        }

        if (!known) revert UnknownAccount();

        emit AccountStatusUpdated(account, active);
    }

    function isAccount(address account) external view returns (bool) {
        return _activeAccounts[account];
    }

    function isLendingAccount(address account) external view returns (bool) {
        return _activeLendingAccounts[account];
    }

    function isRegisteredAccount(address account) external view returns (bool) {
        return _registeredAccounts[account];
    }

    function isRegisteredLendingAccount(address account) external view returns (bool) {
        return _registeredLendingAccounts[account];
    }

    function isAccountOwner(address user, address account) external view returns (bool) {
        return ownerOfAccount[account] == user;
    }

    function getAccounts(address user) external view returns (address[] memory) {
        return _userToAllAccounts[user];
    }

    function getNormalAccounts(address user) external view returns (address[] memory) {
        return _userToAccounts[user];
    }

    function getLendingAccounts(address user) external view returns (address[] memory) {
        return _userToLendingAccounts[user];
    }

    function accountCount(address user) external view returns (uint256) {
        return _userToAllAccounts[user].length;
    }

    function normalAccountCount(address user) external view returns (uint256) {
        return _userToAccounts[user].length;
    }

    function lendingAccountCount(address user) external view returns (uint256) {
        return _userToLendingAccounts[user].length;
    }

    function latestAccount(address user) external view returns (address) {
        return _latest(_userToAllAccounts[user]);
    }

    function latestNormalAccount(address user) external view returns (address) {
        return _latest(_userToAccounts[user]);
    }

    function latestLendingAccount(address user) external view returns (address) {
        return _latest(_userToLendingAccounts[user]);
    }

    function _latest(address[] storage accounts) private view returns (address) {
        uint256 length = accounts.length;

        if (length == 0) {
            return address(0);
        }

        return accounts[length - 1];
    }

    function _removeFromArray(address[] storage accounts, address account) private {
        uint256 length = accounts.length;

        for (uint256 i = 0; i < length; i++) {
            if (accounts[i] == account) {
                accounts[i] = accounts[length - 1];
                accounts.pop();
                return;
            }
        }

        revert AccountNotOwned();
    }
}
