import { getAddress, ZeroAddress } from "ethers";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function requireAddress(name: string): string {
  const value = getAddress(requireEnv(name));

  if (value === ZeroAddress) {
    throw new Error(`${name} cannot be the zero address`);
  }

  return value;
}

export function getTestnetDeploymentConfig() {
  return {
    environment: "testnet",
    expectedChainId: BigInt(requireEnv("SETHX_TESTNET_CHAIN_ID")),
    outputDir: "deployments/testnet",
    founderAddresses: [
      requireAddress("SETHX_FOUNDER_1_ADDRESS"),
      requireAddress("SETHX_FOUNDER_2_ADDRESS"),
      requireAddress("SETHX_FOUNDER_3_ADDRESS"),
    ],
  } as const;
}
