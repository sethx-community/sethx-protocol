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

  const optionsOrderBook = await ethers.deployContract("OptionsOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.optionContract,
    deployment.addresses.feeManager,
    deployerAddress,
  ]);

  await optionsOrderBook.waitForDeployment();

  return {
    optionsOrderBook,
    addresses: {
      optionsOrderBook: await optionsOrderBook.getAddress(),
    },
  };
}
