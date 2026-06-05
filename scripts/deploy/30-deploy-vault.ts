import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployVault(
  ethers: any,
  deployment: {
    addresses: {
      sethxToken: string;
      accountRegistry?: string;
      sethxVault?: string;
    };
    onCheckpoint?: (addresses: {
      accountRegistry?: string;
      sethxVault?: string;
    }) => void | Promise<void>;
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  let accountRegistryAddress = deployment.addresses.accountRegistry;

  let accountRegistry: any;

  if (
    typeof accountRegistryAddress === "string" &&
    accountRegistryAddress.length > 0
  ) {
    accountRegistry = await ethers.getContractAt(
      "AccountRegistry",
      accountRegistryAddress,
    );
  } else {
    accountRegistry = await safeDeployContract(ethers, "AccountRegistry", [
      deployerAddress,
    ]);

    accountRegistryAddress = await accountRegistry.getAddress();

    await deployment.onCheckpoint?.({
      accountRegistry: accountRegistryAddress,
    });
  }

  let sethxVaultAddress = deployment.addresses.sethxVault;

  let sethxVault: any;

  if (typeof sethxVaultAddress === "string" && sethxVaultAddress.length > 0) {
    sethxVault = await ethers.getContractAt("SethxVault", sethxVaultAddress);
  } else {
    sethxVault = await safeDeployContract(ethers, "SethxVault", [
      accountRegistryAddress,
      deployerAddress,
      deployment.addresses.sethxToken,
    ]);

    sethxVaultAddress = await sethxVault.getAddress();

    await deployment.onCheckpoint?.({
      accountRegistry: accountRegistryAddress,
      sethxVault: sethxVaultAddress,
    });
  }

  return {
    accountRegistry,
    sethxVault,
    addresses: {
      accountRegistry: accountRegistryAddress,
      sethxVault: sethxVaultAddress,
    },
  };
}
