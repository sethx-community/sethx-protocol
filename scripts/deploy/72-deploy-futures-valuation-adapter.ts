export async function deployFuturesValuationAdapter(
  ethers: any,
  deployment: {
    addresses: {
      futuresContract: string;
      sethxVault: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const futuresValuationAdapter = await ethers.deployContract(
    "FuturesValuationAdapter",
    [
      deployment.addresses.futuresContract,
      deployment.addresses.sethxVault,
      deployerAddress,
    ],
  );

  await futuresValuationAdapter.waitForDeployment();

  return {
    futuresValuationAdapter,
    addresses: {
      futuresValuationAdapter: await futuresValuationAdapter.getAddress(),
    },
  };
}
