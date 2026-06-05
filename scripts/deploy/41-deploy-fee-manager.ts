import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployFeeManager(
  ethers: any,
  deployment: {
    addresses: {
      sethxToken: string;
      priceManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const feeManager = await safeDeployContract(ethers, "FeeManager", [
    deployment.addresses.sethxToken,
    deployment.addresses.priceManager,
    deployerAddress,
  ]);

  return {
    feeManager,
    addresses: {
      feeManager: await feeManager.getAddress(),
    },
  };
}
