export async function deployValuationModule(
  ethers: any,
  deployment: {
    addresses: {
      priceManager: string;
      lendingContract: string;
      sethxVault: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const valuationModule = await ethers.deployContract("ValuationModule", [
    deployment.addresses.priceManager,
    deployment.addresses.lendingContract,
    deployment.addresses.sethxVault,
    deployerAddress,
  ]);

  await valuationModule.waitForDeployment();

  return {
    valuationModule,
    addresses: {
      valuationModule: await valuationModule.getAddress(),
    },
  };
}
