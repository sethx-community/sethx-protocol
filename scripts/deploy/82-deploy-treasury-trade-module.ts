export async function deployTreasuryTradeModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      protocolTreasury: string;
      accountFactory: string;
      accountRegistry: string;
      sethxVault: string;
    };
  },
) {
  const TreasuryTradeModule = await ethers.getContractFactory(
    "TreasuryTradeModule",
  );

  const treasuryTradeModule = await TreasuryTradeModule.deploy(
    deployment.addresses.treasuryAuthority,
    deployment.addresses.protocolTreasury,
    deployment.addresses.accountFactory,
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
  );

  await treasuryTradeModule.waitForDeployment();

  return {
    addresses: {
      treasuryTradeModule: await treasuryTradeModule.getAddress(),
    },
  };
}
