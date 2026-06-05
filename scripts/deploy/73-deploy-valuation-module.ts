import { safeDeployContract } from "./safe-deploy-contract.js";

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

  const valuationModule = await safeDeployContract(ethers, "ValuationModule", [
    deployment.addresses.priceManager,
    deployment.addresses.lendingContract,
    deployment.addresses.sethxVault,
    deployerAddress,
  ]);

  return {
    valuationModule,
    addresses: {
      valuationModule: await valuationModule.getAddress(),
    },
  };
}
