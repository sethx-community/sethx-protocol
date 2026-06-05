import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";

import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { setupTokenEthOracles } from "../setup/84-setup-token-eth-oracles.js";
import { writeDeploymentOutput } from "../output/write-deployment.js";

const SETHX_FEE_CONVERSION_ORACLE =
  "0xF6CC59b7086C7AD12b1989EbeCF313222567181C";

const OLD_PENDING_USDC_ETH_ORACLE =
  "0xa84DE6155ab4020921f101344D7642f79BA39fFa";

const REPLACEMENT_USDC_ETH_ORACLE =
  "0x6786d468d6d1eb1461ac80d61058270cca67d9e2";

const USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const USDC_ETH_FEED = "0x986b5E1e1755e3C2440e960477f25201B0a8bbD4";

function latestDeploymentPath(outputDir: string) {
  return path.join(outputDir, "latest.json");
}

function readDeploymentOutput(outputDir: string): any {
  const latestPath = latestDeploymentPath(outputDir);

  if (!fs.existsSync(latestPath)) {
    throw new Error(`Missing deployment output at ${latestPath}`);
  }

  return JSON.parse(fs.readFileSync(latestPath, "utf8"));
}

function requireAddress(deployment: any, key: string): string {
  const value = deployment?.addresses?.[key];

  if (!value || typeof value !== "string") {
    throw new Error(`Missing deployment address: ${key}`);
  }

  return getAddress(value);
}

async function requireDeployedCode(
  ethers: any,
  address: string,
  label: string,
) {
  const code = await ethers.provider.getCode(address);

  if (!code || code === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
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

  const existing = readDeploymentOutput(config.outputDir);

  if (!existing?.stages?.["83"]) {
    throw new Error("Stage 83 must be complete before Stage 84 resume");
  }

  if (existing?.stages?.["84"]) {
    throw new Error("Stage 84 is already marked complete");
  }

  const priceManagerAddress = requireAddress(existing, "priceManager");
  const sethxTokenAddress = requireAddress(existing, "sethxToken");

  console.log("Resuming Stage 84 on mainnet");
  console.log("priceManager:", priceManagerAddress);
  console.log("sethxToken:", sethxTokenAddress);
  console.log("SethxFeeConversionOracle:", SETHX_FEE_CONVERSION_ORACLE);
  console.log("replacement USDC/ETH oracle:", REPLACEMENT_USDC_ETH_ORACLE);

  await requireDeployedCode(
    ethers,
    SETHX_FEE_CONVERSION_ORACLE,
    "SethxFeeConversionOracle",
  );

  await requireDeployedCode(
    ethers,
    REPLACEMENT_USDC_ETH_ORACLE,
    "Replacement ChainlinkUsdcEthOracle",
  );

  const priceManager = await ethers.getContractAt(
    "PriceManager",
    priceManagerAddress,
  );

  const sethxFeeConversionOracle = await ethers.getContractAt(
    "SethxFeeConversionOracle",
    SETHX_FEE_CONVERSION_ORACLE,
  );

  const replacementUsdcEthOracle = await ethers.getContractAt(
    "ChainlinkUsdcEthOracle",
    REPLACEMENT_USDC_ETH_ORACLE,
  );

  const sethxApproved = await priceManager.isApprovedOracle(
    SETHX_FEE_CONVERSION_ORACLE,
  );

  if (!sethxApproved) {
    throw new Error("SethxFeeConversionOracle is not approved");
  }

  const oldStillApproved = await priceManager.isApprovedOracle(
    OLD_PENDING_USDC_ETH_ORACLE,
  );

  if (oldStillApproved) {
    console.log("Old USDC/ETH oracle still approved; removing it...");

    const tx = await priceManager.removeOracle(OLD_PENDING_USDC_ETH_ORACLE);
    console.log("remove old oracle tx:", tx.hash);
    await tx.wait();
  } else {
    console.log("Old USDC/ETH oracle is not approved.");
  }

  const tokenEthOracleSetup = await setupTokenEthOracles(ethers, {
    addresses: {
      priceManager: priceManagerAddress,
      usdcToken: USDC_TOKEN,
      usdcEthOracle: REPLACEMENT_USDC_ETH_ORACLE,
    },
  });

  const replacementApproved = await priceManager.isApprovedOracle(
    REPLACEMENT_USDC_ETH_ORACLE,
  );

  if (!replacementApproved) {
    throw new Error("Replacement USDC/ETH oracle was not approved");
  }

  const sethxLastPrice = await sethxFeeConversionOracle.getLastPrice();
  const replacementLastPrice = await replacementUsdcEthOracle.getLastPrice();

  console.log("Sethx oracle last price:", sethxLastPrice);
  console.log("Replacement USDC/ETH last price:", replacementLastPrice);

  if (sethxLastPrice[0] === 0n || sethxLastPrice[3] !== "OK") {
    throw new Error("SethxFeeConversionOracle is not initialized/OK");
  }

  if (replacementLastPrice[0] === 0n || replacementLastPrice[3] !== "OK") {
    throw new Error("Replacement USDC/ETH oracle is not initialized/OK");
  }

  const now = new Date().toISOString();

  const output = {
    ...existing,
    addresses: {
      ...(existing.addresses ?? {}),
      sethxFeeConversionOracle: getAddress(SETHX_FEE_CONVERSION_ORACLE),
      usdcToken: getAddress(USDC_TOKEN),
      usdcEthFeed: getAddress(USDC_ETH_FEED),
      usdcEthOracle: getAddress(REPLACEMENT_USDC_ETH_ORACLE),
    },
    oracle: {
      ...(typeof existing.oracle === "object" && existing.oracle !== null
        ? existing.oracle
        : {}),
      sethxFeeConversionOracle: {
        address: getAddress(SETHX_FEE_CONVERSION_ORACLE),
        approved: true,
        recovered: true,
        lastPrice: sethxLastPrice[0].toString(),
        priceTimestamp: sethxLastPrice[1].toString(),
        lastFetchTimestamp: sethxLastPrice[2].toString(),
        status: sethxLastPrice[3],
      },
      tokenEthOracles: tokenEthOracleSetup.tokenEthOracles,
      stage84Recovery: {
        recoveredAt: now,
        oldPendingUsdcEthOracle: getAddress(OLD_PENDING_USDC_ETH_ORACLE),
        replacementUsdcEthOracle: getAddress(REPLACEMENT_USDC_ETH_ORACLE),
        usdcToken: getAddress(USDC_TOKEN),
        usdcEthFeed: getAddress(USDC_ETH_FEED),
        replacementMaxStaleness: "0",
        reason:
          "Original USDC/ETH oracle was deployed with immutable maxStaleness=86400 and remained PENDING because adapter-level staleness blocked fetchPrice. Replacement disables adapter-level staleness; PriceManager freshness remains responsible for protocol usage.",
      },
    },
    updatedAt: now,
    stages: {
      ...(existing.stages ?? {}),
      "84": {
        completedAt: now,
        description:
          "Recovered Stage 84: SethxFeeConversionOracle already deployed and registered; old pending USDC/ETH oracle removed; replacement USDC/ETH Chainlink-compatible oracle deployed and registered; WBTC/ETH intentionally skipped",
      },
    },
  };

  writeDeploymentOutput(config.outputDir, output);

  console.log("Stage 84 resume complete.");
}

await main();
