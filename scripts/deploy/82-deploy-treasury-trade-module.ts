import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployTreasuryTradeModule(
  ethers: any,
  deployment: {
    addresses: {
      treasuryAuthority: string;
      protocolTreasury: string;
      accountFactory: string;
      accountRegistry: string;
      sethxVault: string;
      futuresContract: string;
    };
  },
) {
  const treasuryTradeModule = await safeDeployContract(
    ethers,
    "TreasuryTradeModule",
    [
      deployment.addresses.treasuryAuthority,
      deployment.addresses.protocolTreasury,
      deployment.addresses.accountFactory,
      deployment.addresses.accountRegistry,
      deployment.addresses.sethxVault,
    ],
  );

  const treasuryFuturesMaintenanceModule = await safeDeployContract(
    ethers,
    "TreasuryFuturesMaintenanceModule",
    [
      deployment.addresses.treasuryAuthority,
      deployment.addresses.protocolTreasury,
      deployment.addresses.futuresContract,
    ],
  );

  return {
    addresses: {
      treasuryTradeModule: await treasuryTradeModule.getAddress(),
      treasuryFuturesMaintenanceModule:
        await treasuryFuturesMaintenanceModule.getAddress(),
    },
  };
}
