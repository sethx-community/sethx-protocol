export async function deployOptionsValuationAdapter(
  ethers: any,
  deployment: {
    addresses: {
      priceManager: string;
      optionContract: string;
      marginOptionContract: string;
      binaryMarginOptionContract: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const optionsValuationAdapter = await ethers.deployContract(
    "OptionsValuationAdapter",
    [
      deployment.addresses.priceManager,
      deployment.addresses.optionContract,
      deployment.addresses.marginOptionContract,
      deployment.addresses.binaryMarginOptionContract,
      deployerAddress,
    ],
  );

  await optionsValuationAdapter.waitForDeployment();

  return {
    optionsValuationAdapter,
    addresses: {
      optionsValuationAdapter: await optionsValuationAdapter.getAddress(),
    },
  };
}
