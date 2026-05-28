export async function deployBinaryMarginOptionContract(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      accountRegistry: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const binaryMarginOptionContract = await ethers.deployContract(
    "BinaryMarginOptionContract",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployerAddress,
    ],
  );

  await binaryMarginOptionContract.waitForDeployment();

  return {
    binaryMarginOptionContract,
    addresses: {
      binaryMarginOptionContract: await binaryMarginOptionContract.getAddress(),
    },
  };
}
