import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployOptionContract(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const optionContract = await safeDeployContract(ethers, "OptionContract", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  return {
    optionContract,
    addresses: {
      optionContract: await optionContract.getAddress(),
    },
  };
}
