export type DeploymentEnvironment = "local" | "testnet" | "mainnet";

export interface TokenDistributionConfig {
  totalSupplyWholeTokens: bigint;
  founderBps: bigint;
  founderLockSeconds: bigint;
  founderAddress: string;
}

export interface DeploymentConfig {
  environment: DeploymentEnvironment;
  expectedChainId: bigint;
  requireMainnetConfirmation: boolean;
  token: TokenDistributionConfig;
}
