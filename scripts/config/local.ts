export const LOCAL_DEPLOYMENT_CONFIG = {
  environment: "local",
  expectedChainId: 31337n,
  outputDir: "deployments/local",

  // Hardhat local account #1. This is allowed only for local deployment.
  founderAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
} as const;
