import { safeDeployContract } from "./safe-deploy-contract.js";

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

  const riskModule = await safeDeployContract(ethers, "RiskModule", [
    deployment.addresses.valuationModule,
    deployerAddress,
  ]);

  return {
    riskModule,
    addresses: {
      riskModule: await riskModule.getAddress(),
    },
  };
}
