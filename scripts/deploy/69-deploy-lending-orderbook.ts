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

  const lendingOrderBook = await ethers.deployContract("LendingOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.lendingContract,
    deployerAddress,
  ]);

  await lendingOrderBook.waitForDeployment();

  return {
    lendingOrderBook,
    addresses: {
      lendingOrderBook: await lendingOrderBook.getAddress(),
    },
  };
}
