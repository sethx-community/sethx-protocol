import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployMarginOptionsOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      marginOptionContract: string;
      feeManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const marginOptionsOrderBook = await safeDeployContract(ethers, 
    "MarginOptionsOrderBook",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployment.addresses.marginOptionContract,
      deployment.addresses.feeManager,
      deployerAddress,
    ],
  );

  return {
    marginOptionsOrderBook,
    addresses: {
      marginOptionsOrderBook: await marginOptionsOrderBook.getAddress(),
    },
  };
}
