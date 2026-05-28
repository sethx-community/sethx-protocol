export async function deployPassiveFuturesSnapshotPublisher(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      futuresOrderBook: string;
    };
  },
) {
  const PassiveFuturesSnapshotPublisher = await ethers.getContractFactory(
    "PassiveFuturesSnapshotPublisher",
  );

  const publisher = await PassiveFuturesSnapshotPublisher.deploy(
    deployment.addresses.treasuryAuthority,
    deployment.addresses.futuresOrderBook,
  );

  await publisher.waitForDeployment();

  return {
    addresses: {
      passiveFuturesSnapshotPublisher: await publisher.getAddress(),
    },
  };
}
