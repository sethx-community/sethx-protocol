export async function deployVault(ethers: any) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const accountRegistry = await ethers.deployContract("AccountRegistry", [
    deployerAddress,
  ]);
  await accountRegistry.waitForDeployment();

  const sethxVault = await ethers.deployContract("SethxVault", [
    await accountRegistry.getAddress(),
    deployerAddress,
  ]);
  await sethxVault.waitForDeployment();

  return {
    accountRegistry,
    sethxVault,
    addresses: {
      accountRegistry: await accountRegistry.getAddress(),
      sethxVault: await sethxVault.getAddress(),
    },
  };
}
