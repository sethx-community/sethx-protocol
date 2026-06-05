import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployPassiveFuturesPoolFactory(
  ethers: any,
  deployment: {
    addresses: {
      futuresContract: string;
      sethxVault: string;
      accountRegistry: string;
      futuresOrderBook: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();

  const factory = await safeDeployContract(ethers, "PassiveFuturesPoolFactory", [
    deployment.addresses.futuresContract,
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.futuresOrderBook,
    await deployer.getAddress(),
  ]);

  return {
    addresses: {
      passiveFuturesPoolFactory: await factory.getAddress(),
    },
  };
}
