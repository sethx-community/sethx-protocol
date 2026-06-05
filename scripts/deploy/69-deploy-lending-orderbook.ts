import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployLendingOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      lendingContract: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const lendingOrderBook = await safeDeployContract(ethers, "LendingOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.lendingContract,
    deployerAddress,
  ]);

  return {
    lendingOrderBook,
    addresses: {
      lendingOrderBook: await lendingOrderBook.getAddress(),
    },
  };
}
