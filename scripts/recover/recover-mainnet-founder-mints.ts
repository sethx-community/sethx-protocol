import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";
import { writeDeploymentOutput } from "../output/write-deployment.js";

type FounderTimelockOutput = {
  address: string;
  allocation: string | bigint;
};

type DeploymentOutput = {
  environment: string;
  chainId: string | number | bigint;
  deployedAt: string;
  updatedAt?: string;
  founderAddresses: readonly string[];
  addresses?: {
    sethxToken?: string;
    protocolTreasury?: string;
    founderTokenTimelocks?: FounderTimelockOutput[];
    [key: string]: unknown;
  };
  stages?: Record<string, { completedAt: string; description: string }>;
  tokenDistribution?: unknown;
  [key: string]: unknown;
};

function readDeploymentOutput(outputDir: string): DeploymentOutput {
  const latestPath = path.join(outputDir, "latest.json");

  if (!fs.existsSync(latestPath)) {
    throw new Error(`Missing deployment output at ${latestPath}`);
  }

  return JSON.parse(fs.readFileSync(latestPath, "utf8")) as DeploymentOutput;
}

function requireAddress(
  output: DeploymentOutput,
  key: "sethxToken" | "protocolTreasury",
): string {
  const value = output.addresses?.[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Deployment output is missing addresses.${key}`);
  }

  return value;
}

async function wait(txPromise: Promise<any>) {
  const tx = await txPromise;
  console.log(`Sent tx: ${tx.hash}`);
  await tx.wait();
  return tx;
}

async function main() {
  const config = getMainnetDeploymentConfig();
  const { ethers } = await network.connect("mainnet");

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  const output = readDeploymentOutput(config.outputDir);

  const sethxTokenAddress = requireAddress(output, "sethxToken");
  const protocolTreasury = requireAddress(output, "protocolTreasury");
  const founderTimelocks = output.addresses?.founderTokenTimelocks;

  if (!Array.isArray(founderTimelocks) || founderTimelocks.length !== 6) {
    throw new Error("Deployment output must contain six founder timelocks");
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const token = await ethers.getContractAt("SethxToken", sethxTokenAddress);

  const minter = await token.minter();
  if (minter.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Current minter is ${minter}, expected deployer ${deployerAddress}`,
    );
  }

  const mintingFinished = await token.mintingFinished();
  if (mintingFinished) {
    throw new Error("Minting is already finished. Refusing to recover.");
  }

  const expectedTreasury = INITIAL_PROTOCOL_PARAMETERS.token.treasuryAllocation;
  const treasuryBalance = await token.balanceOf(protocolTreasury);

  if (treasuryBalance !== expectedTreasury) {
    throw new Error(
      `Unexpected treasury balance. Expected ${expectedTreasury}, got ${treasuryBalance}`,
    );
  }

  console.log("Treasury allocation is already minted correctly.");

  let founderTotal = 0n;

  for (const [index, lock] of founderTimelocks.entries()) {
    const expected = BigInt(lock.allocation);
    const current = await token.balanceOf(lock.address);

    if (current > expected) {
      throw new Error(
        `Founder timelock ${index + 1} balance too high. Expected ${expected}, got ${current}`,
      );
    }

    if (current < expected) {
      const missing = expected - current;

      console.log(
        `Minting founder timelock ${index + 1}: ${missing.toString()} to ${lock.address}`,
      );

      await wait(
        token.mint(lock.address, missing, {
          gasLimit: 150_000n,
        }),
      );
    } else {
      console.log(`Founder timelock ${index + 1} already funded.`);
    }

    founderTotal += expected;
  }

  const expectedTotal =
    INITIAL_PROTOCOL_PARAMETERS.token.treasuryAllocation + founderTotal;

  const totalSupplyBeforeFinish = await token.totalSupply();
  if (totalSupplyBeforeFinish !== expectedTotal) {
    throw new Error(
      `Unexpected total supply before finish. Expected ${expectedTotal}, got ${totalSupplyBeforeFinish}`,
    );
  }

  console.log("All founder allocations minted. Finishing minting.");

  await wait(
    token.finishMinting({
      gasLimit: 120_000n,
    }),
  );

  const totalSupplyAfter = await token.totalSupply();
  if (totalSupplyAfter !== INITIAL_PROTOCOL_PARAMETERS.token.totalSupply) {
    throw new Error(
      `Unexpected final total supply. Expected ${INITIAL_PROTOCOL_PARAMETERS.token.totalSupply}, got ${totalSupplyAfter}`,
    );
  }

  const finalMinter = await token.minter();
  if (finalMinter !== ethers.ZeroAddress) {
    throw new Error(`Final minter is not zero: ${finalMinter}`);
  }

  const updatedOutput: DeploymentOutput = {
    ...output,
    updatedAt: new Date().toISOString(),
    tokenDistribution: {
      totalSupply: INITIAL_PROTOCOL_PARAMETERS.token.totalSupply,
      founderAmount: INITIAL_PROTOCOL_PARAMETERS.token.founderAllocation,
      founderTimelockTotal: founderTotal,
      founderTimelocks: founderTimelocks.map((lock) => ({
        address: lock.address,
        allocation: BigInt(lock.allocation),
      })),
      treasuryAmount: INITIAL_PROTOCOL_PARAMETERS.token.treasuryAllocation,
      recovery: {
        treasuryMintAlreadyCompleted: true,
        founderMintRecoveryCompleted: true,
        recoveredAt: new Date().toISOString(),
      },
    },
    stages: {
      ...(output.stages ?? {}),
      "10": {
        completedAt: new Date().toISOString(),
        description:
          "Recovered token distribution after treasury mint by minting founder allocations and finishing minting",
      },
    },
  };

  writeDeploymentOutput(config.outputDir, updatedOutput);

  console.log("Founder mint recovery completed successfully.");
  console.log(`Total supply: ${totalSupplyAfter.toString()}`);
}

await main();
