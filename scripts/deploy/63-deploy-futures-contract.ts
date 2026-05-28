export async function deployFuturesContract(
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

  const futuresContract = await ethers.deployContract("FuturesContract", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  await futuresContract.waitForDeployment();

  return {
    futuresContract,
    addresses: {
      futuresContract: await futuresContract.getAddress(),
    },
  };
}
