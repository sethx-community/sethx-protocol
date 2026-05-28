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

  const tokenSpotOrderBook = await ethers.deployContract("TokenSpotOrderBook", [
    deployment.addresses.sethxVault,
    deployment.addresses.feeManager,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  await tokenSpotOrderBook.waitForDeployment();

  return {
    tokenSpotOrderBook,
    addresses: {
      tokenSpotOrderBook: await tokenSpotOrderBook.getAddress(),
    },
  };
}
