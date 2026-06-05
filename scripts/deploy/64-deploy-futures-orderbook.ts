import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployFuturesOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      futuresContract: string;
      feeManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const futuresOrderBook = await safeDeployContract(ethers, "FuturesOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.futuresContract,
    deployment.addresses.feeManager,
    deployerAddress,
  ]);

  return {
    futuresOrderBook,
    addresses: {
      futuresOrderBook: await futuresOrderBook.getAddress(),
    },
  };
}
