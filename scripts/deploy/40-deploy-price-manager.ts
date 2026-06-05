import { safeDeployContract } from "./safe-deploy-contract.js";

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

  const priceManager = await safeDeployContract(ethers, "PriceManager", [
    deployerAddress,
    parameters.oracleDefaults.staleTimeoutSeconds,
  ]);

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
