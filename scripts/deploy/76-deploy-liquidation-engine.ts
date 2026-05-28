export async function deployLiquidationEngine(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      lendingContract: string;
      lendingOrderBook: string;
      valuationModule: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const liquidationEngine = await ethers.deployContract("LiquidationEngine", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.lendingContract,
    deployment.addresses.lendingOrderBook,
    deployment.addresses.valuationModule,
    deployerAddress,
  ]);

  await liquidationEngine.waitForDeployment();

  return {
    liquidationEngine,
    addresses: {
      liquidationEngine: await liquidationEngine.getAddress(),
    },
  };
}
