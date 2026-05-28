export async function deployFeeManager(
  ethers: any,
  deployment: {
    addresses: {
      sethxToken: string;
      priceManager: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const feeManager = await ethers.deployContract("FeeManager", [
    deployment.addresses.sethxToken,
    deployment.addresses.priceManager,
    deployerAddress,
  ]);
  await feeManager.waitForDeployment();

  return {
    feeManager,
    addresses: {
      feeManager: await feeManager.getAddress(),
    },
  };
}
