async function grantIfMissing(contract: any, role: string, target: string) {
  if (!(await contract.hasRole(role, target))) {
    const tx = await contract.grantRole(role, target);
    await tx.wait();
  }
}

export async function setupGovernanceAdminHandoff(
  ethers: any,
  deployment: {
    addresses: {
      sethxTimelock: string;
      sethxGovernor: string;
      accountRegistry: string;
      sethxVault: string;
      priceManager: string;
      feeManager: string;
      tokenSpotOrderBook?: string;
      nftSpotOrderBook?: string;
      optionContract?: string;
      optionsOrderBook?: string;
      binaryMarginOptionContract?: string;
      binaryMarginOptionsOrderBook?: string;
      marginOptionContract?: string;
      marginOptionsOrderBook?: string;
      futuresContract?: string;
      futuresPositionStore?: string;
      futuresOrderBook?: string;
      lendingContract?: string;
      lendingOrderBook?: string;
      optionsValuationAdapter?: string;
      futuresValuationAdapter?: string;
      valuationModule?: string;
      riskModule?: string;
      liquidationEngine?: string;
      accountFactory?: string;
      lendingAccountFactory?: string;
      treasuryAuthority?: string;
      treasuryPaymentsModule?: string;
      treasuryVaultModule?: string;
      treasuryTradeModule?: string;
      treasuryFuturesMaintenanceModule?: string;
      passiveFuturesSnapshotPublisher?: string;
      passiveFuturesPoolFactory?: string;
      sethxFeeConversionOracle?: string;
      usdcEthOracle?: string;
      wbtcEthOracle?: string;
      [key: string]: any;
    };
  },
) {
  const timelock = deployment.addresses.sethxTimelock;
  const governor = deployment.addresses.sethxGovernor;

  const granted: Record<string, unknown> = {};

  async function grantRoleIfAddress(
    contractName: string,
    address: string | undefined,
    roleGetter: string,
    target: string,
    label: string,
  ) {
    if (!address) return false;

    const contract = await ethers.getContractAt(contractName, address);

    if (typeof contract[roleGetter] !== "function") return false;

    const role = await contract[roleGetter]();
    await grantIfMissing(contract, role, target);

    granted[label] = await contract.hasRole(role, target);

    return true;
  }

  // Core protocol admin/control roles.
  await grantRoleIfAddress(
    "AccountRegistry",
    deployment.addresses.accountRegistry,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "accountRegistryDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "SethxVault",
    deployment.addresses.sethxVault,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "vaultDefaultAdminToTimelock",
  );
  await grantRoleIfAddress(
    "SethxVault",
    deployment.addresses.sethxVault,
    "GOVERNOR_ROLE",
    timelock,
    "vaultGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "PriceManager",
    deployment.addresses.priceManager,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "priceManagerDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "FeeManager",
    deployment.addresses.feeManager,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "feeManagerDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "OptionsValuationAdapter",
    deployment.addresses.optionsValuationAdapter,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "optionsValuationAdapterDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "OptionsValuationAdapter",
    deployment.addresses.optionsValuationAdapter,
    "GOVERNOR_ROLE",
    timelock,
    "optionsValuationAdapterGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesValuationAdapter",
    deployment.addresses.futuresValuationAdapter,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "futuresValuationAdapterDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesValuationAdapter",
    deployment.addresses.futuresValuationAdapter,
    "GOVERNOR_ROLE",
    timelock,
    "futuresValuationAdapterGovernorToTimelock",
  );

  // Market/admin roles.
  await grantRoleIfAddress(
    "TokenSpotOrderBook",
    deployment.addresses.tokenSpotOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "tokenSpotDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "NFTSpotOrderBook",
    deployment.addresses.nftSpotOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "nftSpotDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "OptionsOrderBook",
    deployment.addresses.optionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "optionsOrderBookDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "BinaryMarginOptionsOrderBook",
    deployment.addresses.binaryMarginOptionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "binaryMarginOptionsOrderBookDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "MarginOptionsOrderBook",
    deployment.addresses.marginOptionsOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "marginOptionsOrderBookDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "futuresOrderBookDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "lendingOrderBookDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
    "GOVERNOR_ROLE",
    timelock,
    "lendingOrderBookGovernorToTimelock",
  );

  // Product contracts.
  await grantRoleIfAddress(
    "OptionContract",
    deployment.addresses.optionContract,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "optionContractDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "OptionContract",
    deployment.addresses.optionContract,
    "GOVERNOR_ROLE",
    timelock,
    "optionContractGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "BinaryMarginOptionContract",
    deployment.addresses.binaryMarginOptionContract,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "binaryMarginOptionContractDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "BinaryMarginOptionContract",
    deployment.addresses.binaryMarginOptionContract,
    "GOVERNOR_ROLE",
    timelock,
    "binaryMarginOptionContractGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "MarginOptionContract",
    deployment.addresses.marginOptionContract,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "marginOptionContractDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "MarginOptionContract",
    deployment.addresses.marginOptionContract,
    "GOVERNOR_ROLE",
    timelock,
    "marginOptionContractGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesContract",
    deployment.addresses.futuresContract,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "futuresContractDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesContract",
    deployment.addresses.futuresContract,
    "GOVERNOR_ROLE",
    timelock,
    "futuresContractGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "FuturesPositionStore",
    deployment.addresses.futuresPositionStore,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "futuresPositionStoreDefaultAdminToTimelock",
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

    await grantIfMissing(
      futuresPositionStore,
      engineRole,
      deployment.addresses.futuresContract,
    );

    granted.futuresPositionStoreEngineRoleToFuturesContract =
      await futuresPositionStore.hasRole(
        engineRole,
        deployment.addresses.futuresContract,
      );
  }

  await grantRoleIfAddress(
    "LendingContract",
    deployment.addresses.lendingContract,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "lendingContractDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LendingContract",
    deployment.addresses.lendingContract,
    "GOVERNOR_ROLE",
    timelock,
    "lendingContractGovernorToTimelock",
  );

  // Risk / valuation / liquidation.
  await grantRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "valuationModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "GOVERNOR_ROLE",
    timelock,
    "valuationModuleGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "RISK_ADMIN_ROLE",
    timelock,
    "valuationModuleRiskAdminToTimelock",
  );

  await grantRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "riskModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "GOVERNOR_ROLE",
    timelock,
    "riskModuleGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "RiskModule",
    deployment.addresses.riskModule,
    "RISK_ADMIN_ROLE",
    timelock,
    "riskModuleRiskAdminToTimelock",
  );

  await grantRoleIfAddress(
    "ValuationModule",
    deployment.addresses.valuationModule,
    "RISK_ADMIN_ROLE",
    timelock,
    "valuationModuleRiskAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LiquidationEngine",
    deployment.addresses.liquidationEngine,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "liquidationEngineDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LiquidationEngine",
    deployment.addresses.liquidationEngine,
    "GOVERNOR_ROLE",
    timelock,
    "liquidationEngineGovernorToTimelock",
  );

  // Treasury.
  await grantRoleIfAddress(
    "TreasuryAuthority",
    deployment.addresses.treasuryAuthority,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "treasuryAuthorityDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "TreasuryAuthority",
    deployment.addresses.treasuryAuthority,
    "GOVERNOR_ROLE",
    timelock,
    "treasuryAuthorityGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "ProtocolTreasury",
    deployment.addresses.protocolTreasury,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "protocolTreasuryDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "TreasuryPaymentsModule",
    deployment.addresses.treasuryPaymentsModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "treasuryPaymentsModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "TreasuryVaultModule",
    deployment.addresses.treasuryVaultModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "treasuryVaultModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "TreasuryTradeModule",
    deployment.addresses.treasuryTradeModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "treasuryTradeModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "TreasuryFuturesMaintenanceModule",
    deployment.addresses.treasuryFuturesMaintenanceModule,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "treasuryFuturesMaintenanceModuleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LendingAccountFactory",
    deployment.addresses.lendingAccountFactory,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "lendingAccountFactoryDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "LendingAccountFactory",
    deployment.addresses.lendingAccountFactory,
    "GOVERNOR_ROLE",
    timelock,
    "lendingAccountFactoryGovernorToTimelock",
  );

  if (deployment.addresses.lendingAccountFactory) {
    const lendingAccountFactory = await ethers.getContractAt(
      "LendingAccountFactory",
      deployment.addresses.lendingAccountFactory,
    );

    const currentGovernor = await lendingAccountFactory.accountGovernor();

    if (currentGovernor.toLowerCase() !== timelock.toLowerCase()) {
      const tx = await lendingAccountFactory.setAccountGovernor(timelock);
      await tx.wait();
    }

    granted.lendingAccountFactoryAccountGovernorToTimelock =
      (await lendingAccountFactory.accountGovernor()).toLowerCase() ===
      timelock.toLowerCase();
  }

  // Passive futures.
  await grantRoleIfAddress(
    "PassiveFuturesSnapshotPublisher",
    deployment.addresses.passiveFuturesSnapshotPublisher,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "passivePublisherDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "PassiveFuturesPoolFactory",
    deployment.addresses.passiveFuturesPoolFactory,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "passivePoolFactoryDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "PassiveFuturesPoolFactory",
    deployment.addresses.passiveFuturesPoolFactory,
    "GOVERNOR_ROLE",
    timelock,
    "passivePoolFactoryGovernorToTimelock",
  );

  // Fee conversion oracle.
  await grantRoleIfAddress(
    "SethxFeeConversionOracle",
    deployment.addresses.sethxFeeConversionOracle,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "sethxFeeConversionOracleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "SethxFeeConversionOracle",
    deployment.addresses.sethxFeeConversionOracle,
    "GOVERNOR_ROLE",
    timelock,
    "sethxFeeConversionOracleGovernorToTimelock",
  );

  // Immutable token/ETH Chainlink oracle adapters still expose AccessControl for
  // governor-only funding-token rescue. Hand those roles to Timelock too.
  await grantRoleIfAddress(
    "ChainlinkUsdcEthOracle",
    deployment.addresses.usdcEthOracle,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "usdcEthOracleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "ChainlinkUsdcEthOracle",
    deployment.addresses.usdcEthOracle,
    "GOVERNOR_ROLE",
    timelock,
    "usdcEthOracleGovernorToTimelock",
  );

  await grantRoleIfAddress(
    "ChainlinkWbtcEthOracle",
    deployment.addresses.wbtcEthOracle,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "wbtcEthOracleDefaultAdminToTimelock",
  );

  await grantRoleIfAddress(
    "ChainlinkWbtcEthOracle",
    deployment.addresses.wbtcEthOracle,
    "GOVERNOR_ROLE",
    timelock,
    "wbtcEthOracleGovernorToTimelock",
  );

  return {
    governanceAdminHandoff: {
      timelock,
      governor,
      granted,
    },
  };
}
