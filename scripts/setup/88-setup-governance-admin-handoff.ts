async function grantIfMissing(contract: any, role: string, target: string) {
  if (!(await contract.hasRole(role, target))) {
    const tx = await contract.grantRole(role, target);
    await tx.wait();
  }
}

async function callIfExists(contract: any, fn: string, args: unknown[]) {
  if (typeof contract[fn] !== "function") return false;

  const tx = await contract[fn](...args);
  await tx.wait();

  return true;
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
      futuresOrderBook?: string;
      settlementManager?: string;

      lendingContract?: string;
      lendingOrderBook?: string;
      valuationModule?: string;
      riskModule?: string;
      liquidationEngine?: string;

      accountFactory?: string;
      lendingAccountFactory?: string;

      treasuryAuthority?: string;
      protocolTreasury?: string;
      treasuryPaymentsModule?: string;
      treasuryVaultModule?: string;
      treasuryTradeModule?: string;

      passiveFuturesSnapshotPublisher?: string;
      passiveFuturesPoolFactory?: string;
      sethxFeeConversionOracle?: string;
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
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
    "ADMIN_ROLE",
    timelock,
    "futuresOrderBookAdminToTimelock",
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
    "FuturesContract",
    deployment.addresses.futuresContract,
    "MARKET_MANAGER_ROLE",
    timelock,
    "futuresContractMarketManagerToTimelock",
  );

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
    "AccountFactory",
    deployment.addresses.accountFactory,
    "DEFAULT_ADMIN_ROLE",
    timelock,
    "accountFactoryDefaultAdminToTimelock",
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

    if ((await lendingAccountFactory.accountGovernor()) !== timelock) {
      const tx = await lendingAccountFactory.setAccountGovernor(timelock);
      await tx.wait();
    }

    granted.lendingAccountFactoryAccountGovernorToTimelock =
      (await lendingAccountFactory.accountGovernor()) === timelock;
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

  return {
    governanceAdminHandoff: {
      timelock,
      governor,
      granted,
    },
  };
}
