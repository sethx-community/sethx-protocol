export async function deploySettlementManager(
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

  const settlementManager = await ethers.deployContract("SettlementManager", [
    deployment.addresses.futuresContract,
    deployment.addresses.sethxVault,
    deployerAddress,
  ]);

  await settlementManager.waitForDeployment();

  return {
    settlementManager,
    addresses: {
      settlementManager: await settlementManager.getAddress(),
    },
  };
}
