// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { LendingAccount } from "./LendingAccount.sol";
import { AccountRegistry } from "./AccountRegistry.sol";
import { LendingContract } from "../markets/lending/LendingContract.sol";

contract LendingAccountFactory is AccessControl {
    // -------- Errors --------
    error ZeroAddress();
    error LendingContractNotSet();
    error RiskModuleNotSet();
    error FactoryRiskModuleMismatch();

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    address public immutable registry;
    address public immutable vault;

    address public accountGovernor;
    address public lendingContract;
    address public riskModule;
    address public liquidationEngine;

    event AccountGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);

    event LendingAccountCreated(
        address indexed user,
        address indexed account,
        address indexed lendingContract,
        address riskModule,
        address liquidationEngine
    );

    event LendingContractUpdated(
        address indexed oldLendingContract,
        address indexed newLendingContract
    );

    event RiskModuleUpdated(address indexed oldRiskModule, address indexed newRiskModule);

    event LiquidationEngineUpdated(
        address indexed oldLiquidationEngine,
        address indexed newLiquidationEngine
    );

    constructor(address _registry, address _vault, address admin, address _liquidationEngine) {
        if (_registry == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (_liquidationEngine == address(0)) revert ZeroAddress();

        registry = _registry;
        vault = _vault;
        accountGovernor = admin;
        liquidationEngine = _liquidationEngine;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setAccountGovernor(address newAccountGovernor) external onlyRole(GOVERNOR_ROLE) {
        if (newAccountGovernor == address(0)) revert ZeroAddress();

        address old = accountGovernor;
        accountGovernor = newAccountGovernor;

        emit AccountGovernorUpdated(old, newAccountGovernor);
    }

    function setLendingContract(address newLendingContract) external onlyRole(GOVERNOR_ROLE) {
        if (newLendingContract == address(0)) revert ZeroAddress();

        address old = lendingContract;
        lendingContract = newLendingContract;

        emit LendingContractUpdated(old, newLendingContract);
    }

    function setRiskModule(address newRiskModule) external onlyRole(GOVERNOR_ROLE) {
        if (newRiskModule == address(0)) revert ZeroAddress();

        address old = riskModule;
        riskModule = newRiskModule;

        emit RiskModuleUpdated(old, newRiskModule);
    }

    function setLiquidationEngine(address newLiquidationEngine) external onlyRole(GOVERNOR_ROLE) {
        if (newLiquidationEngine == address(0)) revert ZeroAddress();

        address old = liquidationEngine;
        liquidationEngine = newLiquidationEngine;

        emit LiquidationEngineUpdated(old, newLiquidationEngine);
    }

    function createLendingAccount() external returns (address account) {
        if (lendingContract == address(0)) revert LendingContractNotSet();
        if (riskModule == address(0)) revert RiskModuleNotSet();
        if (liquidationEngine == address(0)) revert ZeroAddress();

        if (address(LendingContract(payable(lendingContract)).riskModule()) != riskModule) {
            revert FactoryRiskModuleMismatch();
        }

        account = address(
            new LendingAccount(
                msg.sender,
                vault,
                lendingContract,
                riskModule,
                accountGovernor,
                liquidationEngine
            )
        );

        AccountRegistry(registry).registerLendingAccount(msg.sender, account);

        emit LendingAccountCreated(
            msg.sender,
            account,
            lendingContract,
            riskModule,
            liquidationEngine
        );
    }
}
