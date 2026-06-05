async function renounceIfTimelockHasRole(
  contract: any,
  role: string,
  deployer: string,
  timelock: string,
) {
  if (!(await contract.hasRole(role, timelock))) {
    throw new Error(
      "Refusing to renounce deployer role: timelock does not have role",
    );
  }

  if (await contract.hasRole(role, deployer)) {
    const tx = await contract.renounceRole(role, deployer);
    await tx.wait();
  }
}

export async function revokeBootstrapAdmin(
  ethers: any,
  deployment: {
    addresses: Record<string, string | undefined> & {
      sethxTimelock: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const timelock = deployment.addresses.sethxTimelock;

  const revoked: Record<string, boolean> = {};

  async function renounceRoleIfAddress(
    contractName: string,
    address: string | undefined,
    roleGetter: string,
    label: string,
  ) {
    if (!address) return false;

    const contract = await ethers.getContractAt(contractName, address);

    if (typeof contract[roleGetter] !== "function") return false;

    const role = await contract[roleGetter]();

    await renounceIfTimelockHasRole(contract, role, deployerAddress, timelock);

    revoked[label] = !(await contract.hasRole(role, deployerAddress));

    return true;
  }

  async function renounceRoleIfReplacementHasRole(
    contractName: string,
    address: string | undefined,
    roleGetter: string,
    replacement: string | undefined,
    label: string,
    replacementLabel: string,
  ) {
    if (!address) return false;

    const contract = await ethers.getContractAt(contractName, address);

    if (typeof contract[roleGetter] !== "function") return false;

    if (!replacement) {
      throw new Error(
        `Refusing to revoke deployer ${roleGetter}: replacement address is missing`,
      );
    }

    const role = await contract[roleGetter]();

    if (!(await contract.hasRole(role, replacement))) {
      throw new Error(
        `Refusing to revoke deployer ${roleGetter}: replacement does not have role`,
      );
    }

    if (await contract.hasRole(role, deployerAddress)) {
      const tx = await contract.renounceRole(role, deployerAddress);
      await tx.wait();
    }

    revoked[label] = !(await contract.hasRole(role, deployerAddress));
    revoked[replacementLabel] = await contract.hasRole(role, replacement);

    return true;
  }

  await renounceRoleIfAddress(
    "AccountRegistry",
    deployment.addresses.accountRegistry,
    "DEFAULT_ADMIN_ROLE",
    "accountRegistryDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "SethxVault",
    deployment.addresses.sethxVault,
    "DEFAULT_ADMIN_ROLE",
    "vaultDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "SethxVault",
    deployment.addresses.sethxVault,
    "GOVERNOR_ROLE",
    "vaultGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "OptionsValuationAdapter",
    deployment.addresses.optionsValuationAdapter,
    "DEFAULT_ADMIN_ROLE",
    "optionsValuationAdapterDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "OptionsValuationAdapter",
    deployment.addresses.optionsValuationAdapter,
    "GOVERNOR_ROLE",
    "optionsValuationAdapterGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesValuationAdapter",
    deployment.addresses.futuresValuationAdapter,
    "DEFAULT_ADMIN_ROLE",
    "futuresValuationAdapterDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesValuationAdapter",
    deployment.addresses.futuresValuationAdapter,
    "GOVERNOR_ROLE",
    "futuresValuationAdapterGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "PriceManager",
    deployment.addresses.priceManager,
    "DEFAULT_ADMIN_ROLE",
    "priceManagerDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "FeeManager",
    deployment.addresses.feeManager,
    "DEFAULT_ADMIN_ROLE",
    "feeManagerDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TokenSpotOrderBook",
    deployment.addresses.tokenSpotOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "tokenSpotDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "NFTSpotOrderBook",
    deployment.addresses.nftSpotOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "nftSpotDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "OptionsOrderBook",
    deployment.addresses.optionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "optionsOrderBookDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "BinaryMarginOptionsOrderBook",
    deployment.addresses.binaryMarginOptionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "binaryMarginOptionsOrderBookDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "MarginOptionsOrderBook",
    deployment.addresses.marginOptionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "marginOptionsOrderBookDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "futuresOrderBookDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
    "ADMIN_ROLE",
    "futuresOrderBookAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
    "DEFAULT_ADMIN_ROLE",
    "lendingOrderBookDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
    "GOVERNOR_ROLE",
    "lendingOrderBookGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "OptionContract",
    deployment.addresses.optionContract,
    "DEFAULT_ADMIN_ROLE",
    "optionContractDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "OptionContract",
    deployment.addresses.optionContract,
    "GOVERNOR_ROLE",
    "optionContractGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "BinaryMarginOptionContract",
    deployment.addresses.binaryMarginOptionContract,
    "DEFAULT_ADMIN_ROLE",
    "binaryMarginOptionContractDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "BinaryMarginOptionContract",
    deployment.addresses.binaryMarginOptionContract,
    "GOVERNOR_ROLE",
    "binaryMarginOptionContractGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "MarginOptionContract",
    deployment.addresses.marginOptionContract,
    "DEFAULT_ADMIN_ROLE",
    "marginOptionContractDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "MarginOptionContract",
    deployment.addresses.marginOptionContract,
    "GOVERNOR_ROLE",
    "marginOptionContractGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesContract",
    deployment.addresses.futuresContract,
    "DEFAULT_ADMIN_ROLE",
    "futuresContractDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesContract",
    deployment.addresses.futuresContract,
    "GOVERNOR_ROLE",
    "futuresContractGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "FuturesPositionStore",
    deployment.addresses.futuresPositionStore,
    "DEFAULT_ADMIN_ROLE",
    "futuresPositionStoreDefaultAdminRevoked",
  );

  if (
    deployment.addresses.futuresPositionStore &&
    deployment.addresses.futuresContract
  ) {
    const futuresPositionStore = await ethers.getContractAt(
      "FuturesPositionStore",
      deployment.addresses.futuresPositionStore,
    );

    const engineRole = await futuresPositionStore.FUTURES_ENGINE_ROLE();

    const futuresContractHasEngineRole = await futuresPositionStore.hasRole(
      engineRole,
      deployment.addresses.futuresContract,
    );

    if (!futuresContractHasEngineRole) {
      throw new Error(
        "Refusing to revoke deployer FUTURES_ENGINE_ROLE: FuturesContract does not have FUTURES_ENGINE_ROLE",
      );
    }

    if (await futuresPositionStore.hasRole(engineRole, deployerAddress)) {
      const tx = await futuresPositionStore.renounceRole(
        engineRole,
        deployerAddress,
      );
      await tx.wait();
    }

    revoked.futuresPositionStoreBootstrapEngineRevoked =
      !(await futuresPositionStore.hasRole(engineRole, deployerAddress));

    revoked.futuresPositionStoreEngineRoleKeptOnFuturesContract =
      await futuresPositionStore.hasRole(
        engineRole,
        deployment.addresses.futuresContract,
      );
  }

  // Revoke the deployer's bootstrap lending loss authority before GOVERNOR_ROLE.
  // The LiquidationEngine is the only runtime component that should hold this
  // role for liquidation repayment and loss-finalization calls.
  await renounceRoleIfReplacementHasRole(
    "LendingContract",
    deployment.addresses.lendingContract,
    "LOSS_MANAGER_ROLE",
    deployment.addresses.liquidationEngine,
    "lendingContractLossManagerRevoked",
    "lendingContractLossManagerKeptOnLiquidationEngine",
  );

  await renounceRoleIfAddress(
    "LendingContract",
    deployment.addresses.lendingContract,
    "DEFAULT_ADMIN_ROLE",
    "lendingContractDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LendingContract",
    deployment.addresses.lendingContract,
    "GOVERNOR_ROLE",
    "lendingContractGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "DEFAULT_ADMIN_ROLE",
    "valuationModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "GOVERNOR_ROLE",
    "valuationModuleGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "DEFAULT_ADMIN_ROLE",
    "riskModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "GOVERNOR_ROLE",
    "riskModuleGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "RISK_ADMIN_ROLE",
    "riskModuleRiskAdminRevoked",
  );

  await renounceRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "RISK_ADMIN_ROLE",
    "valuationModuleRiskAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LiquidationEngine",
    deployment.addresses.liquidationEngine,
    "DEFAULT_ADMIN_ROLE",
    "liquidationEngineDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LiquidationEngine",
    deployment.addresses.liquidationEngine,
    "GOVERNOR_ROLE",
    "liquidationEngineGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryAuthority",
    deployment.addresses.treasuryAuthority,
    "DEFAULT_ADMIN_ROLE",
    "treasuryAuthorityDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryAuthority",
    deployment.addresses.treasuryAuthority,
    "GOVERNOR_ROLE",
    "treasuryAuthorityGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "ProtocolTreasury",
    deployment.addresses.protocolTreasury,
    "DEFAULT_ADMIN_ROLE",
    "protocolTreasuryDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryPaymentsModule",
    deployment.addresses.treasuryPaymentsModule,
    "DEFAULT_ADMIN_ROLE",
    "treasuryPaymentsModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryVaultModule",
    deployment.addresses.treasuryVaultModule,
    "DEFAULT_ADMIN_ROLE",
    "treasuryVaultModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryTradeModule",
    deployment.addresses.treasuryTradeModule,
    "DEFAULT_ADMIN_ROLE",
    "treasuryTradeModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "TreasuryFuturesMaintenanceModule",
    deployment.addresses.treasuryFuturesMaintenanceModule,
    "DEFAULT_ADMIN_ROLE",
    "treasuryFuturesMaintenanceModuleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "SethxFeeConversionOracle",
    deployment.addresses.sethxFeeConversionOracle,
    "DEFAULT_ADMIN_ROLE",
    "sethxFeeConversionOracleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "SethxFeeConversionOracle",
    deployment.addresses.sethxFeeConversionOracle,
    "GOVERNOR_ROLE",
    "sethxFeeConversionOracleGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "ChainlinkUsdcEthOracle",
    deployment.addresses.usdcEthOracle,
    "DEFAULT_ADMIN_ROLE",
    "usdcEthOracleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "ChainlinkUsdcEthOracle",
    deployment.addresses.usdcEthOracle,
    "GOVERNOR_ROLE",
    "usdcEthOracleGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "ChainlinkWbtcEthOracle",
    deployment.addresses.wbtcEthOracle,
    "DEFAULT_ADMIN_ROLE",
    "wbtcEthOracleDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "ChainlinkWbtcEthOracle",
    deployment.addresses.wbtcEthOracle,
    "GOVERNOR_ROLE",
    "wbtcEthOracleGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "AccountFactory",
    deployment.addresses.accountFactory,
    "DEFAULT_ADMIN_ROLE",
    "accountFactoryDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LendingAccountFactory",
    deployment.addresses.lendingAccountFactory,
    "DEFAULT_ADMIN_ROLE",
    "lendingAccountFactoryDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "LendingAccountFactory",
    deployment.addresses.lendingAccountFactory,
    "GOVERNOR_ROLE",
    "lendingAccountFactoryGovernorRevoked",
  );

  await renounceRoleIfAddress(
    "PassiveFuturesSnapshotPublisher",
    deployment.addresses.passiveFuturesSnapshotPublisher,
    "DEFAULT_ADMIN_ROLE",
    "passiveFuturesSnapshotPublisherDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "PassiveFuturesPoolFactory",
    deployment.addresses.passiveFuturesPoolFactory,
    "DEFAULT_ADMIN_ROLE",
    "passiveFuturesPoolFactoryDefaultAdminRevoked",
  );

  await renounceRoleIfAddress(
    "PassiveFuturesPoolFactory",
    deployment.addresses.passiveFuturesPoolFactory,
    "GOVERNOR_ROLE",
    "passiveFuturesPoolFactoryGovernorRevoked",
  );

  return {
    bootstrapAdminRevocation: {
      deployer: deployerAddress,
      timelock,
      revoked,
    },
  };
}
