// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title TreasuryAuthority
 * @notice Section 1 authority layer for treasury modules.
 *
 * Responsibilities:
 * - register and revoke treasurers
 * - store per-treasurer permissions
 * - freeze individual treasurers
 * - expose a global kill switch for all treasurer actions
 * - provide a single source of truth for downstream treasury modules
 *
 * Governance assumptions:
 * - the timelock is the permanent governor/admin path
 * - governor functions must still work while treasury is killed
 * - guardian / emergency module may only stop treasury execution, not govern it
 */
contract TreasuryAuthority is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant EMERGENCY_MODULE_ROLE = keccak256("EMERGENCY_MODULE_ROLE");

    uint256 public constant PERMISSION_CALL_VAULT = 1 << 0;
    uint256 public constant PERMISSION_MANAGE_LIQUIDITY = 1 << 1;
    uint256 public constant PERMISSION_MANAGE_PAYMENTS = 1 << 2;
    uint256 public constant PERMISSION_TRADE_SETHX = 1 << 3;

    uint256 internal constant _ALL_PERMISSIONS =
        PERMISSION_CALL_VAULT |
            PERMISSION_MANAGE_LIQUIDITY |
            PERMISSION_MANAGE_PAYMENTS |
            PERMISSION_TRADE_SETHX;

    struct TreasurerInfo {
        bool active;
        uint64 appointedAt;
        uint64 revokedAt;
        uint256 permissions;
        string label;
    }

    mapping(address => TreasurerInfo) private _treasurers;
    mapping(address => bool) public frozenTreasurers;
    mapping(address => bool) private _knownTreasurer;
    address[] private _treasurerList;

    bool public killed;

    event TreasurerAppointed(address indexed account, string label, uint256 permissions);
    event TreasurerRevoked(address indexed account);
    event TreasurerPermissionsUpdated(address indexed account, uint256 permissions);
    event TreasurerFrozen(address indexed account);
    event TreasurerUnfrozen(address indexed account);
    event TreasuryKilled(address indexed caller);
    event TreasuryUnkilled(address indexed caller);
    event GuardianUpdated(address indexed account, bool allowed);
    event EmergencyModuleUpdated(address indexed account, bool allowed);

    error Unauthorized();
    error InvalidAddress();
    error AlreadyActive();
    error NotTreasurer();
    error TreasurerFrozenError();
    error TreasuryKilledError();
    error InvalidPermissions();

    constructor(address timelock) {
        if (timelock == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, timelock);
        _grantRole(GOVERNOR_ROLE, timelock);

        _setRoleAdmin(GOVERNOR_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(GUARDIAN_ROLE, GOVERNOR_ROLE);
        _setRoleAdmin(EMERGENCY_MODULE_ROLE, GOVERNOR_ROLE);
    }

    modifier onlyGovernor() {
        if (!hasRole(GOVERNOR_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyGovernorGuardianOrEmergency() {
        if (
            !hasRole(GOVERNOR_ROLE, msg.sender) &&
            !hasRole(GUARDIAN_ROLE, msg.sender) &&
            !hasRole(EMERGENCY_MODULE_ROLE, msg.sender)
        ) revert Unauthorized();
        _;
    }

    function appointTreasurer(
        address account,
        string calldata label,
        uint256 permissions
    ) external onlyGovernor {
        if (account == address(0)) revert InvalidAddress();
        if (_treasurers[account].active) revert AlreadyActive();
        _validatePermissions(permissions);

        if (!_knownTreasurer[account]) {
            _knownTreasurer[account] = true;
            _treasurerList.push(account);
        }

        _treasurers[account] = TreasurerInfo({
            active: true,
            appointedAt: uint64(block.timestamp),
            revokedAt: 0,
            permissions: permissions,
            label: label
        });

        frozenTreasurers[account] = false;
        emit TreasurerAppointed(account, label, permissions);
    }

    function revokeTreasurer(address account) external onlyGovernor {
        if (!_treasurers[account].active) revert NotTreasurer();

        _treasurers[account].active = false;
        _treasurers[account].revokedAt = uint64(block.timestamp);
        _treasurers[account].permissions = 0;
        frozenTreasurers[account] = false;

        emit TreasurerRevoked(account);
    }

    function setTreasurerPermissions(address account, uint256 permissions) external onlyGovernor {
        if (!_treasurers[account].active) revert NotTreasurer();
        _validatePermissions(permissions);

        _treasurers[account].permissions = permissions;
        emit TreasurerPermissionsUpdated(account, permissions);
    }

    function freezeTreasurer(address account) external onlyGovernorGuardianOrEmergency {
        if (!_treasurers[account].active) revert NotTreasurer();
        frozenTreasurers[account] = true;
        emit TreasurerFrozen(account);
    }

    function unfreezeTreasurer(address account) external onlyGovernor {
        if (!_knownTreasurer[account]) revert NotTreasurer();
        frozenTreasurers[account] = false;
        emit TreasurerUnfrozen(account);
    }

    /**
     * @notice Global kill switch for all treasurer actions across all modules.
     * Governor functions remain available while killed.
     */
    function killTreasury() external onlyGovernorGuardianOrEmergency {
        killed = true;
        emit TreasuryKilled(msg.sender);
    }

    function unkillTreasury() external onlyGovernor {
        killed = false;
        emit TreasuryUnkilled(msg.sender);
    }

    function setGuardian(address account, bool allowed) external onlyGovernor {
        if (account == address(0)) revert InvalidAddress();

        if (allowed) _grantRole(GUARDIAN_ROLE, account);
        else _revokeRole(GUARDIAN_ROLE, account);

        emit GuardianUpdated(account, allowed);
    }

    function setEmergencyModule(address account, bool allowed) external onlyGovernor {
        if (account == address(0)) revert InvalidAddress();

        if (allowed) _grantRole(EMERGENCY_MODULE_ROLE, account);
        else _revokeRole(EMERGENCY_MODULE_ROLE, account);

        emit EmergencyModuleUpdated(account, allowed);
    }

    function isTreasurer(address account) public view returns (bool) {
        return _treasurers[account].active;
    }

    function isOperationalTreasurer(address account) public view returns (bool) {
        return _treasurers[account].active && !frozenTreasurers[account] && !killed;
    }

    function hasPermission(address account, uint256 permission) public view returns (bool) {
        return (_treasurers[account].permissions & permission) != 0;
    }

    function canCallAsTreasurer(address account, uint256 permission) external view returns (bool) {
        return isOperationalTreasurer(account) && hasPermission(account, permission);
    }

    /**
     * @notice Shared authorization hook for downstream treasury modules.
     */
    function requireTreasurerPermission(address account, uint256 permission) public view {
        if (killed) revert TreasuryKilledError();
        if (!_treasurers[account].active) revert Unauthorized();
        if (frozenTreasurers[account]) revert TreasurerFrozenError();
        if (!hasPermission(account, permission)) revert Unauthorized();
    }

    function getTreasurerInfo(address account) external view returns (TreasurerInfo memory) {
        return _treasurers[account];
    }

    function getTreasurerPermissions(address account) external view returns (uint256) {
        return _treasurers[account].permissions;
    }

    function getTreasurers() external view returns (address[] memory) {
        return _treasurerList;
    }

    function _validatePermissions(uint256 permissions) internal pure {
        if ((permissions & ~_ALL_PERMISSIONS) != 0) revert InvalidPermissions();
    }
}
