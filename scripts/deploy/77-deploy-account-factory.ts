import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployAccountFactory(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      sethxVault: string;
    };
  },
) {
  const accountFactory = await safeDeployContract(ethers, "AccountFactory", [
    deployment.addresses.accountRegistry,
    deployment.addresses.sethxVault,
  ]);

  return {
    accountFactory,
    addresses: {
      accountFactory: await accountFactory.getAddress(),
    },
  };
}
