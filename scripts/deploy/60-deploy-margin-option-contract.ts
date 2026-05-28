export async function deployMarginOptionContract(
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

  const marginOptionContract = await ethers.deployContract(
    "MarginOptionContract",
    [
      deployment.addresses.sethxVault,
      deployment.addresses.accountRegistry,
      deployerAddress,
    ],
  );

  await marginOptionContract.waitForDeployment();

  return {
    marginOptionContract,
    addresses: {
      marginOptionContract: await marginOptionContract.getAddress(),
    },
  };
}
