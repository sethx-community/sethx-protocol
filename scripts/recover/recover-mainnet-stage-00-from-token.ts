import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";
import { writeDeploymentOutput } from "../output/write-deployment.js";

const BPS_DENOMINATOR = 10_000n;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function latestDeploymentPath(outputDir: string) {
  return path.join(outputDir, "latest.json");
}

async function main() {
  const config = getMainnetDeploymentConfig();
  const { ethers } = await network.connect();

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  const latestPath = latestDeploymentPath(config.outputDir);
  if (fs.existsSync(latestPath)) {
    throw new Error(
      `Deployment output already exists at ${latestPath}. Refusing to overwrite.`,
    );
  }

  const sethxTokenAddress = getAddress(
    requireEnv("SETHX_RECOVER_SETHX_TOKEN_ADDRESS"),
  );
  const tokenDeploymentTxHash = requireEnv("SETHX_RECOVER_TOKEN_DEPLOYMENT_TX");

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const tx = await ethers.provider.getTransaction(tokenDeploymentTxHash);
  if (!tx) {
    throw new Error(
      `Could not find token deployment tx: ${tokenDeploymentTxHash}`,
    );
  }

  if (tx.from.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Token deployment tx was sent by ${tx.from}, but current deployer is ${deployerAddress}`,
    );
  }

  const receipt = await ethers.provider.getTransactionReceipt(
    tokenDeploymentTxHash,
  );
  if (!receipt) {
    throw new Error(
      `Missing receipt for token deployment tx: ${tokenDeploymentTxHash}`,
    );
  }

  if (receipt.status !== 1) {
    throw new Error("Token deployment transaction did not succeed");
  }

  if (!receipt.contractAddress) {
    throw new Error("Token deployment receipt has no contractAddress");
  }

  if (
    receipt.contractAddress.toLowerCase() !== sethxTokenAddress.toLowerCase()
  ) {
    throw new Error(
      `Recovered token address mismatch. Env has ${sethxTokenAddress}, receipt has ${receipt.contractAddress}`,
    );
  }

  const tokenDeploymentBlock = await ethers.provider.getBlock(
    receipt.blockNumber,
  );
  if (!tokenDeploymentBlock) {
    throw new Error(`Missing token deployment block: ${receipt.blockNumber}`);
  }

  const sethxToken = await ethers.getContractAt(
    "SethxToken",
    sethxTokenAddress,
  );

  const minter = await sethxToken.minter();
  if (minter.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Recovered token minter is ${minter}, expected deployer ${deployerAddress}`,
    );
  }

  const totalSupply = await sethxToken.totalSupply();
  if (totalSupply !== 0n) {
    throw new Error(
      `Recovered token already has totalSupply ${totalSupply.toString()}. Expected 0 before stage 10.`,
    );
  }

  const founderTokenTimelocks = [];

  for (const [
    index,
    lock,
  ] of INITIAL_PROTOCOL_PARAMETERS.token.founderTimelocks.entries()) {
    const beneficiary = config.founderAddresses[lock.founderIndex];

    if (!beneficiary) {
      throw new Error(
        `Missing founder address for founder index ${lock.founderIndex}`,
      );
    }

    const releaseTime =
      BigInt(tokenDeploymentBlock.timestamp) + lock.releaseDelaySeconds;

    const allocation =
      (INITIAL_PROTOCOL_PARAMETERS.token.totalSupply * lock.allocationBps) /
      BPS_DENOMINATOR;

    const contract = await ethers.deployContract("FounderTokenTimelock", [
      sethxTokenAddress,
      beneficiary,
      releaseTime,
    ]);
    await contract.waitForDeployment();

    const timelockAddress = await contract.getAddress();

    founderTokenTimelocks.push({
      id: `founder-${lock.founderIndex + 1}-${lock.releaseDelaySeconds.toString()}s`,
      founderIndex: lock.founderIndex,
      beneficiary,
      releaseDelaySeconds: lock.releaseDelaySeconds,
      releaseTime,
      allocationBps: lock.allocationBps,
      allocation,
      address: timelockAddress,
    });

    console.log(
      `Founder timelock ${index + 1}/6 deployed for ${beneficiary}: ${timelockAddress}`,
    );
  }

  const treasuryAuthority = await ethers.deployContract("TreasuryAuthority", [
    deployerAddress,
  ]);
  await treasuryAuthority.waitForDeployment();

  const protocolTreasury = await ethers.deployContract("ProtocolTreasury", [
    await treasuryAuthority.getAddress(),
  ]);
  await protocolTreasury.waitForDeployment();

  const deployedAt = new Date(
    Number(tokenDeploymentBlock.timestamp) * 1000,
  ).toISOString();

  const output = {
    environment: config.environment,
    chainId: chain.chainId,
    deployedAt,
    founderAddresses: config.founderAddresses,
    addresses: {
      sethxToken: sethxTokenAddress,
      founderTokenTimelocks,
      treasuryAuthority: await treasuryAuthority.getAddress(),
      protocolTreasury: await protocolTreasury.getAddress(),
    },
    updatedAt: new Date().toISOString(),
    recovery: {
      recoveredFromTokenDeploymentTx: tokenDeploymentTxHash,
      recoveredSethxToken: sethxTokenAddress,
      recoveredAt: new Date().toISOString(),
    },
    stages: {
      "00": {
        completedAt: new Date().toISOString(),
        description:
          "Recovered stage 00 from existing SETHX token deployment; deployed six founder timelocks, TreasuryAuthority, and ProtocolTreasury",
      },
    },
  };

  writeDeploymentOutput(config.outputDir, output);
}

await main();
