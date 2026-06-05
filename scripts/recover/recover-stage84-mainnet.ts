import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";

import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { setupTokenEthOracles } from "../setup/84-setup-token-eth-oracles.js";
import { writeDeploymentOutput } from "../output/write-deployment.js";

const RECOVERED_SETHX_FEE_CONVERSION_ORACLE =
  "0xF6CC59b7086C7AD12b1989EbeCF313222567181C";

const OLD_PENDING_USDC_ETH_ORACLE =
  "0xa84DE6155ab4020921f101344D7642f79BA39fFa";

const MAINNET_USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const MAINNET_USDC_ETH_FEED = "0x986b5E1e1755e3C2440e960477f25201B0a8bbD4";

const REPLACEMENT_USDC_ORACLE_MAX_STALENESS = 0n;

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

function assertStageCompleted(deployment: any, stage: string) {
  if (!deployment?.stages?.[stage]) {
    throw new Error(`Stage ${stage} must be complete before recovery`);
  }
}

function assertStageNotCompleted(deployment: any, stage: string) {
  if (deployment?.stages?.[stage]) {
    throw new Error(`Stage ${stage} is already marked complete`);
  }
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

  assertStageCompleted(existing, "83");
  assertStageNotCompleted(existing, "84");

  const priceManagerAddress = requireAddress(existing, "priceManager");
  const sethxTokenAddress = requireAddress(existing, "sethxToken");

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Recovering Stage 84 on mainnet");
  console.log("deployer:", deployerAddress);
  console.log("priceManager:", priceManagerAddress);
  console.log("sethxToken:", sethxTokenAddress);
  console.log(
    "recovered SethxFeeConversionOracle:",
    RECOVERED_SETHX_FEE_CONVERSION_ORACLE,
  );
  console.log("old pending USDC/ETH oracle:", OLD_PENDING_USDC_ETH_ORACLE);
  console.log("USDC token:", MAINNET_USDC_TOKEN);
  console.log("USDC/ETH feed:", MAINNET_USDC_ETH_FEED);

  await requireDeployedCode(
    ethers,
    RECOVERED_SETHX_FEE_CONVERSION_ORACLE,
    "Recovered SethxFeeConversionOracle",
  );

  await requireDeployedCode(
    ethers,
    OLD_PENDING_USDC_ETH_ORACLE,
    "Old pending ChainlinkUsdcEthOracle",
  );

  const priceManager = await ethers.getContractAt(
    "PriceManager",
    priceManagerAddress,
  );

  const sethxFeeConversionOracle = await ethers.getContractAt(
    "SethxFeeConversionOracle",
    RECOVERED_SETHX_FEE_CONVERSION_ORACLE,
  );

  const sethxApproved = await priceManager.isApprovedOracle(
    RECOVERED_SETHX_FEE_CONVERSION_ORACLE,
  );

  if (!sethxApproved) {
    throw new Error(
      `Recovered SethxFeeConversionOracle is not approved in PriceManager: ${RECOVERED_SETHX_FEE_CONVERSION_ORACLE}`,
    );
  }

  const sethxLastPrice = await sethxFeeConversionOracle.getLastPrice();
  console.log("SethxFeeConversionOracle last price:", sethxLastPrice);

  if (sethxLastPrice[0] === 0n || sethxLastPrice[3] !== "OK") {
    throw new Error(
      `Recovered SethxFeeConversionOracle is not initialized/OK. Price result: ${sethxLastPrice}`,
    );
  }

  const oldUsdcApproved = await priceManager.isApprovedOracle(
    OLD_PENDING_USDC_ETH_ORACLE,
  );

  if (oldUsdcApproved) {
    console.log("Removing old pending USDC/ETH oracle from PriceManager...");

    const removeTx = await priceManager.removeOracle(
      OLD_PENDING_USDC_ETH_ORACLE,
    );

    console.log("removeOracle tx:", removeTx.hash);
    await removeTx.wait();

    console.log("Old pending USDC/ETH oracle removed.");
  } else {
    console.log("Old pending USDC/ETH oracle is already not approved.");
  }

  console.log(
    "Deploying replacement ChainlinkUsdcEthOracle with maxStaleness = 0...",
  );

  const replacementUsdcEthOracle = await ethers.deployContract(
    "ChainlinkUsdcEthOracle",
    [
      deployerAddress,
      MAINNET_USDC_ETH_FEED,
      REPLACEMENT_USDC_ORACLE_MAX_STALENESS,
    ],
  );

  await replacementUsdcEthOracle.waitForDeployment();

  const replacementUsdcEthOracleAddress =
    await replacementUsdcEthOracle.getAddress();

  console.log(
    "replacement ChainlinkUsdcEthOracle deployed:",
    replacementUsdcEthOracleAddress,
  );

  await requireDeployedCode(
    ethers,
    replacementUsdcEthOracleAddress,
    "Replacement ChainlinkUsdcEthOracle",
  );

  const tokenEthOracleSetup = await setupTokenEthOracles(ethers, {
    addresses: {
      priceManager: priceManagerAddress,
      usdcToken: MAINNET_USDC_TOKEN,
      usdcEthOracle: replacementUsdcEthOracleAddress,
    },
  });

  const replacementApproved = await priceManager.isApprovedOracle(
    replacementUsdcEthOracleAddress,
  );

  if (!replacementApproved) {
    throw new Error(
      `Replacement USDC/ETH oracle was not approved: ${replacementUsdcEthOracleAddress}`,
    );
  }

  const replacementLastPrice = await replacementUsdcEthOracle.getLastPrice();

  console.log("Replacement USDC/ETH last price:", replacementLastPrice);

  if (replacementLastPrice[0] === 0n || replacementLastPrice[3] !== "OK") {
    throw new Error(
      `Replacement USDC/ETH oracle is not initialized/OK. Price result: ${replacementLastPrice}`,
    );
  }

  const oldStillApproved = await priceManager.isApprovedOracle(
    OLD_PENDING_USDC_ETH_ORACLE,
  );

  if (oldStillApproved) {
    throw new Error("Old pending USDC/ETH oracle is still approved");
  }

  const now = new Date().toISOString();

  const output = {
    ...existing,
    addresses: {
      ...(existing.addresses ?? {}),
      sethxFeeConversionOracle: getAddress(
        RECOVERED_SETHX_FEE_CONVERSION_ORACLE,
      ),
      usdcToken: getAddress(MAINNET_USDC_TOKEN),
      usdcEthFeed: getAddress(MAINNET_USDC_ETH_FEED),
      usdcEthOracle: getAddress(replacementUsdcEthOracleAddress),
    },
    oracle: {
      ...(typeof existing.oracle === "object" && existing.oracle !== null
        ? existing.oracle
        : {}),
      sethxFeeConversionOracle: {
        address: getAddress(RECOVERED_SETHX_FEE_CONVERSION_ORACLE),
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
        replacementUsdcEthOracle: getAddress(replacementUsdcEthOracleAddress),
        usdcToken: getAddress(MAINNET_USDC_TOKEN),
        usdcEthFeed: getAddress(MAINNET_USDC_ETH_FEED),
        replacementMaxStaleness:
          REPLACEMENT_USDC_ORACLE_MAX_STALENESS.toString(),
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

  console.log("Stage 84 recovery complete.");
  console.log("Replacement USDC/ETH oracle:", replacementUsdcEthOracleAddress);
}

await main();
