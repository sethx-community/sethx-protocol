import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployLendingContract(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const lendingContract = await safeDeployContract(ethers, "LendingContract", [
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
    deployerAddress,
  ]);

  return {
    lendingContract,
    addresses: {
      lendingContract: await lendingContract.getAddress(),
    },
  };
}
