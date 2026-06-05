import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployTokenSpotOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      feeManager: string;
      accountRegistry: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const tokenSpotOrderBook = await safeDeployContract(ethers, "TokenSpotOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.feeManager,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  return {
    tokenSpotOrderBook,
    addresses: {
      tokenSpotOrderBook: await tokenSpotOrderBook.getAddress(),
    },
  };
}
