export async function deployRiskModule(
  ethers: any,
  deployment: {
    addresses: {
      valuationModule: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const riskModule = await ethers.deployContract("RiskModule", [
    deployment.addresses.valuationModule,
    deployerAddress,
  ]);

  await riskModule.waitForDeployment();

  return {
    riskModule,
    addresses: {
      riskModule: await riskModule.getAddress(),
    },
  };
}
