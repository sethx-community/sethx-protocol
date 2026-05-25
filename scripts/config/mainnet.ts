import {
  assertAddress,
  parseBps,
  parsePositiveInteger,
  parseWholeTokens,
  requireEnv,
} from "./guards.js";
import type { DeploymentConfig } from "./types.js";

const MAINNET_CONFIRMATION = "I_UNDERSTAND_THIS_DEPLOYS_TO_MAINNET";

export function getMainnetConfig(): DeploymentConfig {
  const confirmation = requireEnv("SETHX_CONFIRM_MAINNET_DEPLOYMENT");

  return {
    environment: "mainnet",
    expectedChainId: 1n,
    requireMainnetConfirmation: confirmation === MAINNET_CONFIRMATION,
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
