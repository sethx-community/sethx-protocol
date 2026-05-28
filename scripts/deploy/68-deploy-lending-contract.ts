export async function deployLendingContract(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const lendingContract = await ethers.deployContract("LendingContract", [
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
    deployerAddress,
  ]);

  await lendingContract.waitForDeployment();

  return {
    lendingContract,
    addresses: {
      lendingContract: await lendingContract.getAddress(),
    },
  };
}
