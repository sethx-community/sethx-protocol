export async function deployTreasuryPaymentsModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      protocolTreasury: string;
    };
  },
) {
  const TreasuryPaymentsModule = await ethers.getContractFactory(
    "TreasuryPaymentsModule",
  );

  const treasuryPaymentsModule = await TreasuryPaymentsModule.deploy(
    deployment.addresses.treasuryAuthority,
    deployment.addresses.protocolTreasury,
  );

  await treasuryPaymentsModule.waitForDeployment();

  return {
    addresses: {
      treasuryPaymentsModule: await treasuryPaymentsModule.getAddress(),
    },
  };
}
