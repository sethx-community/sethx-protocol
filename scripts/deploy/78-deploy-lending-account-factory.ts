export async function deployLendingAccountFactory(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
      liquidationEngine: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const lendingAccountFactory = await ethers.deployContract("LendingAccountFactory", [
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
    deployerAddress,
    deployment.addresses.liquidationEngine,
  ]);

  await lendingAccountFactory.waitForDeployment();

  return {
    lendingAccountFactory,
    addresses: {
      lendingAccountFactory: await lendingAccountFactory.getAddress(),
    },
  };
}
