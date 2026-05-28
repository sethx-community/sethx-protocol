export async function deployTreasuryVaultModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      sethxVault: string;
    };
  },
) {
  const TreasuryVaultModule = await ethers.getContractFactory(
    "TreasuryVaultModule",
  );

  const treasuryVaultModule = await TreasuryVaultModule.deploy(
    deployment.addresses.treasuryAuthority,
    deployment.addresses.sethxVault,
  );

  await treasuryVaultModule.waitForDeployment();

  return {
    addresses: {
      treasuryVaultModule: await treasuryVaultModule.getAddress(),
    },
  };
}
