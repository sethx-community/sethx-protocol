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


  async function renounceBootstrapRoleIfAddress(
    contractName: string,
    address: string | undefined,
    roleGetter: string,
    label: string,
  ) {
    if (!address) return false;

    const contract = await ethers.getContractAt(contractName, address);

    if (typeof contract[roleGetter] !== "function") return false;

    const role = await contract[roleGetter]();

    if (await contract.hasRole(role, deployerAddress)) {
      const tx = await contract.renounceRole(role, deployerAddress);
      await tx.wait();
    }

    revoked[label] = !(await contract.hasRole(role, deployerAddress));

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
    "FuturesContract",
    deployment.addresses.futuresContract,
    "MARKET_MANAGER_ROLE",
    "futuresContractMarketManagerRevoked",
  );

  await renounceBootstrapRoleIfAddress(
    "FuturesContract",
    deployment.addresses.futuresContract,
    "SETTLEMENT_MANAGER_ROLE",
    "futuresContractBootstrapSettlementManagerRevoked",
  );

  await renounceBootstrapRoleIfAddress(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
    "SETTLEMENT_MANAGER_ROLE",
    "futuresOrderBookBootstrapSettlementManagerRevoked",
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
