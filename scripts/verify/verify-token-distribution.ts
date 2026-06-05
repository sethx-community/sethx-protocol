import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { LOCAL_DEPLOYMENT_CONFIG } from "../config/local.js";
import { getTestnetDeploymentConfig } from "../config/testnet.js";
import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

type SethxEnvironment = "local" | "testnet" | "mainnet";

type FounderTimelockOutput = {
  id: string;
  founderIndex: number;
  beneficiary: string;
  releaseDelaySeconds: string | bigint;
  releaseTime: string | bigint;
  allocationBps: string | bigint;
  allocation: string | bigint;
  address: string;
};

type DeploymentOutput = {
  environment: SethxEnvironment;
  chainId: string | number | bigint;
  founderAddresses: readonly string[];
  addresses?: {
    sethxToken?: string;
    protocolTreasury?: string;
    founderTokenTimelocks?: FounderTimelockOutput[];
  };
};

function getEnvironmentName(): SethxEnvironment {
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

function latestDeploymentPath(outputDir: string) {
  return path.join(outputDir, "latest.json");
}

function requireAddress(
  output: DeploymentOutput,
  key: "sethxToken" | "protocolTreasury",
) {
  const value = output.addresses?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Deployment output is missing addresses.${key}`);
  }
  return value;
}

function readDeploymentOutput(outputDir: string): DeploymentOutput {
  const latestPath = latestDeploymentPath(outputDir);
  if (!fs.existsSync(latestPath)) {
    throw new Error(`Missing deployment output at ${latestPath}`);
  }
  return JSON.parse(fs.readFileSync(latestPath, "utf8")) as DeploymentOutput;
}

function assertEqual(
  actual: bigint | string,
  expected: bigint | string,
  label: string,
) {
  const actualBigInt = BigInt(actual);
  const expectedBigInt = BigInt(expected);
  if (actualBigInt !== expectedBigInt) {
    throw new Error(
      `${label}: expected ${expectedBigInt.toString()}, got ${actualBigInt.toString()}`,
    );
  }
}

async function main() {
  const config = getDeploymentConfig();
  const output = readDeploymentOutput(config.outputDir);

  // IMPORTANT:
  // Use the selected Hardhat network from --network.
  // Do not use network.create(), because that can use the local simulated network.
  const { ethers } = await network.connect();

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  if (BigInt(output.chainId) !== chain.chainId) {
    throw new Error(
      `Deployment output chain ID mismatch. Output has ${output.chainId}, connected to ${chain.chainId}`,
    );
  }

  const sethxTokenAddress = requireAddress(output, "sethxToken");
  const protocolTreasury = requireAddress(output, "protocolTreasury");
  const founderTimelocks = output.addresses?.founderTokenTimelocks;

  if (!Array.isArray(founderTimelocks) || founderTimelocks.length !== 6) {
    throw new Error("Deployment output must contain six founder timelocks");
  }

  const sethxToken = await ethers.getContractAt(
    "SethxToken",
    sethxTokenAddress,
  );

  const totalSupply = await sethxToken.totalSupply();
  assertEqual(
    totalSupply,
    INITIAL_PROTOCOL_PARAMETERS.token.totalSupply,
    "totalSupply",
  );

  const treasuryBalance = await sethxToken.balanceOf(protocolTreasury);
  assertEqual(
    treasuryBalance,
    INITIAL_PROTOCOL_PARAMETERS.token.treasuryAllocation,
    "treasury balance",
  );

  let founderTotal = 0n;
  for (const [index, lock] of founderTimelocks.entries()) {
    const balance = await sethxToken.balanceOf(lock.address);
    assertEqual(
      balance,
      lock.allocation,
      `founder timelock ${index + 1} balance`,
    );
    founderTotal += BigInt(lock.allocation);

    const timelock = await ethers.getContractAt(
      "FounderTokenTimelock",
      lock.address,
    );
    const beneficiary = await timelock.beneficiary();
    const releaseTime = await timelock.releaseTime();
    const token = await timelock.token();

    if (beneficiary.toLowerCase() !== lock.beneficiary.toLowerCase()) {
      throw new Error(`founder timelock ${index + 1} beneficiary mismatch`);
    }

    if (token.toLowerCase() !== sethxTokenAddress.toLowerCase()) {
      throw new Error(`founder timelock ${index + 1} token mismatch`);
    }

    assertEqual(
      releaseTime,
      lock.releaseTime,
      `founder timelock ${index + 1} releaseTime`,
    );
  }

  assertEqual(
    founderTotal,
    INITIAL_PROTOCOL_PARAMETERS.token.founderAllocation,
    "founder total",
  );

  const mintingFinished = await sethxToken.mintingFinished();
  if (mintingFinished !== true) {
    throw new Error("SETHX minting is not finished");
  }

  const minter = await sethxToken.minter();
  if (minter !== ethers.ZeroAddress) {
    throw new Error(`SETHX minter is not zero: ${minter}`);
  }

  console.log("Token distribution verified successfully");
  console.log(`SETHX token: ${sethxTokenAddress}`);
  console.log(`Protocol treasury: ${protocolTreasury}`);
  console.log(`Founder timelocks: ${founderTimelocks.length}`);
}

await main();
