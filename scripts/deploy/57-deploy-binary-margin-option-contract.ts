import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployBinaryMarginOptionContract(
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

  const binaryMarginOptionContract = await safeDeployContract(ethers, 
    "BinaryMarginOptionContract",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployerAddress,
    ],
  );

  return {
    binaryMarginOptionContract,
    addresses: {
      binaryMarginOptionContract: await binaryMarginOptionContract.getAddress(),
    },
  };
}
