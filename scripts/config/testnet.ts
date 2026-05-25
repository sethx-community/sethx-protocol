import {
  assertAddress,
  parseBps,
  parsePositiveInteger,
  parseWholeTokens,
  requireEnv,
} from "./guards.js";
import type { DeploymentConfig } from "./types.js";

export function getTestnetConfig(): DeploymentConfig {
  return {
    environment: "testnet",
    expectedChainId: BigInt(requireEnv("SETHX_TESTNET_CHAIN_ID")),
    requireMainnetConfirmation: false,
    token: {
      totalSupplyWholeTokens: parseWholeTokens(
        "SETHX_TOTAL_SUPPLY",
        requireEnv("SETHX_TOTAL_SUPPLY"),
      ),
      founderBps: parseBps(
        "SETHX_FOUNDER_BPS",
        requireEnv("SETHX_FOUNDER_BPS"),
      ),
      founderLockSeconds: parsePositiveInteger(
        "SETHX_FOUNDER_LOCK_SECONDS",
        requireEnv("SETHX_FOUNDER_LOCK_SECONDS"),
      ),
      founderAddress: assertAddress(
        "SETHX_FOUNDER_ADDRESS",
        requireEnv("SETHX_FOUNDER_ADDRESS"),
      ),
    },
  };
}
