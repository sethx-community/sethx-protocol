import { network } from "hardhat";
import { LOCAL_DEPLOYMENT_CONFIG } from "./config/local.js";
import { getTestnetDeploymentConfig } from "./config/testnet.js";
import { getMainnetDeploymentConfig } from "./config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "./parameters/initial-protocol-parameters.js";
import { deployTokenAndTreasury } from "./deploy/00-deploy-token-and-treasury.js";
import { setupTokenDistribution } from "./setup/10-token-distribution.js";
import { writeDeploymentOutput } from "./output/write-deployment.js";

function getEnvironmentName() {
  const environment = process.env.SETHX_DEPLOYMENT_ENVIRONMENT;

  if (
    environment === "local" ||
    environment === "testnet" ||
    environment === "mainnet"
  ) {
    return environment;
  }

  throw new Error(
    "SETHX_DEPLOYMENT_ENVIRONMENT must be local, testnet, or mainnet",
  );
}

function getDeploymentConfig() {
  const environment = getEnvironmentName();

  if (environment === "local") return LOCAL_DEPLOYMENT_CONFIG;
  if (environment === "testnet") return getTestnetDeploymentConfig();
  return getMainnetDeploymentConfig();
}

async function main() {
  const config = getDeploymentConfig();
  const { ethers } = await network.create();

  const chain = await ethers.provider.getNetwork();

  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  const deployment = await deployTokenAndTreasury(
    ethers,
    config,
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const distribution = await setupTokenDistribution(
    INITIAL_PROTOCOL_PARAMETERS,
    deployment,
  );

  writeDeploymentOutput(config.outputDir, {
    environment: config.environment,
    chainId: chain.chainId,
    deployedAt: new Date().toISOString(),
    founderAddress: config.founderAddress,
    founderReleaseTime: deployment.founderReleaseTime,
    addresses: deployment.addresses,
    tokenDistribution: distribution,
  });
}

await main();
