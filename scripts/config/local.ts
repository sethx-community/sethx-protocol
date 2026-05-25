import {
  assertAddress,
  parseBps,
  parsePositiveInteger,
  parseWholeTokens,
  readOptionalEnv,
} from "./guards.js";
import type { DeploymentConfig } from "./types.js";

const twoYearsSeconds = 2n * 365n * 24n * 60n * 60n;

export function getLocalConfig(
  defaultFounderAddress: string,
): DeploymentConfig {
  const totalSupplyWholeTokens = parseWholeTokens(
    "SETHX_TOTAL_SUPPLY",
    readOptionalEnv("SETHX_TOTAL_SUPPLY") ?? "1000000000",
  );

  const founderBps = parseBps(
    "SETHX_FOUNDER_BPS",
    readOptionalEnv("SETHX_FOUNDER_BPS") ?? "2000",
  );

  const founderLockSeconds = parsePositiveInteger(
    "SETHX_FOUNDER_LOCK_SECONDS",
    readOptionalEnv("SETHX_FOUNDER_LOCK_SECONDS") ?? twoYearsSeconds.toString(),
  );

  const founderAddress = assertAddress(
    "SETHX_FOUNDER_ADDRESS",
    readOptionalEnv("SETHX_FOUNDER_ADDRESS") ?? defaultFounderAddress,
  );

  return {
    environment: "local",
    expectedChainId: 31337n,
    requireMainnetConfirmation: false,
    token: {
      totalSupplyWholeTokens,
      founderBps,
      founderLockSeconds,
      founderAddress,
    },
  };
}
