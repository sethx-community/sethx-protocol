import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployTreasuryVaultModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      sethxVault: string;
    };
  },
) {
  const treasuryVaultModule = await safeDeployContract(
    ethers,
    "TreasuryVaultModule",
    [deployment.addresses.treasuryAuthority, deployment.addresses.sethxVault],
  );

  return {
    addresses: {
      treasuryVaultModule: await treasuryVaultModule.getAddress(),
    },
  };
}
