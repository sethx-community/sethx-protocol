import { safeDeployContract } from "./safe-deploy-contract.js";

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

  const futuresPositionStore = await safeDeployContract(
    ethers,
    "FuturesPositionStore",
    [deployerAddress],
  );

  const futuresContract = await safeDeployContract(ethers, "FuturesContract", [
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployerAddress,
  ]);

  const futuresPositionStoreAddress = await futuresPositionStore.getAddress();
  const futuresContractAddress = await futuresContract.getAddress();

  await (
    await futuresContract.setPositionStore(futuresPositionStoreAddress)
  ).wait();

  await (
    await futuresPositionStore.grantRole(
      await futuresPositionStore.FUTURES_ENGINE_ROLE(),
      futuresContractAddress,
    )
  ).wait();

  return {
    futuresPositionStore,
    futuresContract,
    addresses: {
      futuresPositionStore: futuresPositionStoreAddress,
      futuresContract: futuresContractAddress,
    },
  };
}
