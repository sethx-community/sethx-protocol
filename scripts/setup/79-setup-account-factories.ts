import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

export async function setupAccountFactories(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
      accountFactory: string;
      lendingAccountFactory: string;
      liquidationEngine: string;
      lendingContract: string;
      lendingOrderBook: string;
      riskModule: string;
    };
  },
) {
  const accountRegistry = await ethers.getContractAt(
    "AccountRegistry",
    deployment.addresses.accountRegistry,
  );
  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );
  const lendingContract = await ethers.getContractAt(
    "LendingContract",
    deployment.addresses.lendingContract,
  );
  const lendingOrderBook = await ethers.getContractAt(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
  );
  const lendingAccountFactory = await ethers.getContractAt(
    "LendingAccountFactory",
    deployment.addresses.lendingAccountFactory,
  );
  const liquidationEngine = await ethers.getContractAt(
    "LiquidationEngine",
    deployment.addresses.liquidationEngine,
  );
  const riskModule = await ethers.getContractAt(
    "RiskModule",
    deployment.addresses.riskModule,
  );

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const FACTORY_ROLE = await accountRegistry.FACTORY_ROLE();
  const TRANSFER_ROLE = await accountRegistry.TRANSFER_ROLE();

  if (
    !(await accountRegistry.hasRole(
      FACTORY_ROLE,
      deployment.addresses.accountFactory,
    ))
  ) {
    const tx = await accountRegistry.grantRole(
      FACTORY_ROLE,
      deployment.addresses.accountFactory,
    );
    await tx.wait();
  }

  if (
    !(await accountRegistry.hasRole(
      FACTORY_ROLE,
      deployment.addresses.lendingAccountFactory,
    ))
  ) {
    const tx = await accountRegistry.grantRole(
      FACTORY_ROLE,
      deployment.addresses.lendingAccountFactory,
    );
    await tx.wait();
  }

  if (
    !(await accountRegistry.hasRole(
      TRANSFER_ROLE,
      deployment.addresses.liquidationEngine,
    ))
  ) {
    const tx = await accountRegistry.grantRole(
      TRANSFER_ROLE,
      deployment.addresses.liquidationEngine,
    );
    await tx.wait();
  }

  const SETTLEMENT_ROLE = await vault.SETTLEMENT_ROLE();
  if (
    !(await vault.hasRole(
      SETTLEMENT_ROLE,
      deployment.addresses.liquidationEngine,
    ))
  ) {
    const tx = await vault.grantRole(
      SETTLEMENT_ROLE,
      deployment.addresses.liquidationEngine,
    );
    await tx.wait();
  }

  const LOSS_MANAGER_ROLE = await lendingContract.LOSS_MANAGER_ROLE();
  if (
    !(await lendingContract.hasRole(
      LOSS_MANAGER_ROLE,
      deployment.addresses.liquidationEngine,
    ))
  ) {
    const tx = await lendingContract.grantRole(
      LOSS_MANAGER_ROLE,
      deployment.addresses.liquidationEngine,
    );
    await tx.wait();
  }

  const ORDERBOOK_GOVERNOR_ROLE = await lendingOrderBook.GOVERNOR_ROLE();
  if (
    !(await lendingOrderBook.hasRole(ORDERBOOK_GOVERNOR_ROLE, deployerAddress))
  ) {
    throw new Error(
      "Stage 79 deployer is missing LendingOrderBook.GOVERNOR_ROLE",
    );
  }

  const LIQUIDATION_ENGINE_ROLE =
    await lendingOrderBook.LIQUIDATION_ENGINE_ROLE();
  if (
    !(await lendingOrderBook.hasRole(
      LIQUIDATION_ENGINE_ROLE,
      deployment.addresses.liquidationEngine,
    ))
  ) {
    const tx = await lendingOrderBook.setLiquidationEngine(
      deployment.addresses.liquidationEngine,
      true,
    );
    await tx.wait();
  }

  if (
    (await lendingAccountFactory.lendingContract()) !==
    deployment.addresses.lendingContract
  ) {
    const tx = await lendingAccountFactory.setLendingContract(
      deployment.addresses.lendingContract,
    );
    await tx.wait();
  }

  if (
    (await lendingAccountFactory.riskModule()) !==
    deployment.addresses.riskModule
  ) {
    const tx = await lendingAccountFactory.setRiskModule(
      deployment.addresses.riskModule,
    );
    await tx.wait();
  }

  if (
    (await lendingAccountFactory.liquidationEngine()) !==
    deployment.addresses.liquidationEngine
  ) {
    const tx = await lendingAccountFactory.setLiquidationEngine(
      deployment.addresses.liquidationEngine,
    );
    await tx.wait();
  }

  if (
    !(await riskModule.approvedLiquidationEngines(
      deployment.addresses.liquidationEngine,
    ))
  ) {
    const tx = await riskModule.setApprovedLiquidationEngine(
      deployment.addresses.liquidationEngine,
      true,
    );
    await tx.wait();
  }

  const liquidationParams = INITIAL_PROTOCOL_PARAMETERS.liquidation;
  const config = await liquidationEngine.auctionConfig();
  const configNeedsUpdate =
    config.premiumPhaseDuration !==
      BigInt(liquidationParams.premiumPhaseDuration) ||
    config.parPhaseDuration !== BigInt(liquidationParams.parPhaseDuration) ||
    config.discountPhaseDuration !==
      BigInt(liquidationParams.discountPhaseDuration) ||
    config.startPriceBps !== BigInt(liquidationParams.startPriceBps) ||
    config.parPriceBps !== BigInt(liquidationParams.parPriceBps) ||
    config.endPriceBps !== BigInt(liquidationParams.endPriceBps);

  if (configNeedsUpdate) {
    const tx = await liquidationEngine.setAuctionConfig(
      liquidationParams.premiumPhaseDuration,
      liquidationParams.parPhaseDuration,
      liquidationParams.discountPhaseDuration,
      liquidationParams.startPriceBps,
      liquidationParams.parPriceBps,
      liquidationParams.endPriceBps,
    );
    await tx.wait();
  }

  return {
    accountFactories: {
      accountFactoryAuthorized: true,
      lendingAccountFactoryAuthorized: true,
      liquidationEngineConfigured: true,
      liquidationEngineHasOrderBookRole: true,
      liquidationEngineApprovedInRiskModule:
        await riskModule.approvedLiquidationEngines(
          deployment.addresses.liquidationEngine,
        ),
    },
  };
}
