function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

export function getTestnetDeploymentConfig() {
  return {
    environment: "testnet",
    expectedChainId: BigInt(requireEnv("SETHX_TESTNET_CHAIN_ID")),
    outputDir: "deployments/testnet",
    founderAddress: requireEnv("SETHX_FOUNDER_ADDRESS"),
  } as const;
}
