import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployMarginOptionContract(
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

  const marginOptionContract = await safeDeployContract(ethers, 
    "MarginOptionContract",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployerAddress,
    ],
  );

  return {
    marginOptionContract,
    addresses: {
      marginOptionContract: await marginOptionContract.getAddress(),
    },
  };
}
