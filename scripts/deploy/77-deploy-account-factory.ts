export async function deployAccountFactory(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
    };
  },
) {
  const accountFactory = await ethers.deployContract("AccountFactory", [
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
  ]);

  await accountFactory.waitForDeployment();

  return {
    accountFactory,
    addresses: {
      accountFactory: await accountFactory.getAddress(),
    },
  };
}
