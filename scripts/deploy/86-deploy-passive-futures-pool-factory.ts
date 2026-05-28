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

  const PassiveFuturesPoolFactory = await ethers.getContractFactory(
    "PassiveFuturesPoolFactory",
  );

  const factory = await PassiveFuturesPoolFactory.deploy(
    deployment.addresses.futuresContract,
    deployment.addresses.sethxVault,
    deployment.addresses.accountRegistry,
    deployment.addresses.futuresOrderBook,
    await deployer.getAddress(),
  );

  await factory.waitForDeployment();

  return {
    addresses: {
      passiveFuturesPoolFactory: await factory.getAddress(),
    },
  };
}
