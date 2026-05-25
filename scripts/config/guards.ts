import { network } from "hardhat";
const { ethers } = await network.create();

import { getAddress, ZeroAddress } from "ethers";
import { KNOWN_LOCAL_ADDRESSES } from "./known-local-addresses.js";
import type { DeploymentConfig } from "./types.js";

export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

export function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function parseWholeTokens(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole-number token amount`);
  }

  const parsed = BigInt(value);

  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }

  return parsed;
}

export function parseBps(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole-number basis-point value`);
  }

  const parsed = BigInt(value);

  if (parsed < 0n || parsed > 10_000n) {
    throw new Error(`${name} must be between 0 and 10000`);
  }

  return parsed;
}

export function parsePositiveInteger(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = BigInt(value);

  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }

  return parsed;
}

export function assertAddress(name: string, value: string): string {
  try {
    const normalized = getAddress(value);

    if (normalized === ZeroAddress) {
      throw new Error(`${name} cannot be the zero address`);
    }

    return normalized;
  } catch {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
}

export function assertNotKnownLocalAddress(name: string, value: string): void {
  if (KNOWN_LOCAL_ADDRESSES.has(value.toLowerCase())) {
    throw new Error(`${name} cannot be a known local Hardhat address`);
  }
}

export async function assertExpectedChainId(
  ethers: any,
  config: DeploymentConfig,
): Promise<void> {
  const network = await ethers.provider.getNetwork();

  if (network.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${network.chainId}`,
    );
  }
}

export function assertMainnetSafety(config: DeploymentConfig): void {
  if (config.environment !== "mainnet") {
    return;
  }

  if (!config.requireMainnetConfirmation) {
    throw new Error("Mainnet deployment confirmation is required");
  }

  assertNotKnownLocalAddress(
    "SETHX_FOUNDER_ADDRESS",
    config.token.founderAddress,
  );

  if (config.token.founderBps !== 2_000n) {
    throw new Error("Mainnet founder allocation must be 2000 bps");
  }

  if (config.token.founderLockSeconds !== 2n * 365n * 24n * 60n * 60n) {
    throw new Error("Mainnet founder lock must be 2 years");
  }
}
