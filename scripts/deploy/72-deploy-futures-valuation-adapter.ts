import { safeDeployContract } from "./safe-deploy-contract.js";

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

  const futuresValuationAdapter = await safeDeployContract(ethers, 
    "FuturesValuationAdapter",
    [
      deployment.addresses.futuresContract,
      deployment.addresses.sethxVault,
      deployerAddress,
    ],
  );

  return {
    futuresValuationAdapter,
    addresses: {
      futuresValuationAdapter: await futuresValuationAdapter.getAddress(),
    },
  };
}
