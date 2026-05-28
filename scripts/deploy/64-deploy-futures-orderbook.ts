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

  const futuresOrderBook = await ethers.deployContract("FuturesOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.futuresContract,
    deployment.addresses.feeManager,
    deployerAddress,
  ]);

  await futuresOrderBook.waitForDeployment();

  return {
    futuresOrderBook,
    addresses: {
      futuresOrderBook: await futuresOrderBook.getAddress(),
    },
  };
}
