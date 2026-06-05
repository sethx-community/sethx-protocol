import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployOptionsOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
      optionContract: string;
      feeManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const optionsOrderBook = await safeDeployContract(ethers, "OptionsOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.optionContract,
    deployment.addresses.feeManager,
    deployerAddress,
  ]);

  return {
    optionsOrderBook,
    addresses: {
      optionsOrderBook: await optionsOrderBook.getAddress(),
    },
  };
}
