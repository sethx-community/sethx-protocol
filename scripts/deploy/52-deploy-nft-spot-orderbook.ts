export async function deployNftSpotOrderBook(
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

  const nftSpotOrderBook = await ethers.deployContract("NFTSpotOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.feeManager,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  await nftSpotOrderBook.waitForDeployment();

  return {
    nftSpotOrderBook,
    addresses: {
      nftSpotOrderBook: await nftSpotOrderBook.getAddress(),
    },
  };
}
