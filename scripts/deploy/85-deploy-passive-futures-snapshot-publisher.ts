import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployPassiveFuturesSnapshotPublisher(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      futuresOrderBook: string;
    };
  },
) {
  const publisher = await safeDeployContract(
    ethers,
    "PassiveFuturesSnapshotPublisher",
    [deployment.addresses.treasuryAuthority, deployment.addresses.futuresOrderBook],
  );

  return {
    addresses: {
      passiveFuturesSnapshotPublisher: await publisher.getAddress(),
    },
  };
}
