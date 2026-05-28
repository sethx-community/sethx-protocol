export async function deployOptionContract(
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

  const optionContract = await ethers.deployContract("OptionContract", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  await optionContract.waitForDeployment();

  return {
    optionContract,
    addresses: {
      optionContract: await optionContract.getAddress(),
    },
  };
}
