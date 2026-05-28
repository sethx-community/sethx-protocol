export async function deployPriceManager(
  ethers: any,
  parameters: {
    oracleDefaults: {
      staleTimeoutSeconds: number;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const priceManager = await ethers.deployContract("PriceManager", [
    deployerAddress,
    parameters.oracleDefaults.staleTimeoutSeconds,
  ]);
  await priceManager.waitForDeployment();

  return {
    priceManager,
    addresses: {
      priceManager: await priceManager.getAddress(),
    },
    oracleDefaults: {
      staleTimeoutSeconds: parameters.oracleDefaults.staleTimeoutSeconds,
    },
  };
}
