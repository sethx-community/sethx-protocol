import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployTreasuryPaymentsModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      protocolTreasury: string;
    };
  },
) {
  const treasuryPaymentsModule = await safeDeployContract(
    ethers,
    "TreasuryPaymentsModule",
    [
      deployment.addresses.treasuryAuthority,
      deployment.addresses.protocolTreasury,
    ],
  );

  return {
    addresses: {
      treasuryPaymentsModule: await treasuryPaymentsModule.getAddress(),
    },
  };
}
