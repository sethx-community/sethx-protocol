import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployBinaryMarginOptionsOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      binaryMarginOptionContract: string;
      feeManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const binaryMarginOptionsOrderBook = await safeDeployContract(ethers, 
    "BinaryMarginOptionsOrderBook",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployment.addresses.binaryMarginOptionContract,
      deployment.addresses.feeManager,
      deployerAddress,
    ],
  );

  return {
    binaryMarginOptionsOrderBook,
    addresses: {
      binaryMarginOptionsOrderBook:
        await binaryMarginOptionsOrderBook.getAddress(),
    },
  };
}
