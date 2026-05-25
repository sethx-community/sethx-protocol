import { parseUnits } from "ethers";
import type { DeploymentConfig } from "../config/types.js";

export async function setupTokenDistribution(
  config: DeploymentConfig,
  deployment: {
    sethxToken: any;
    addresses: {
      founderTokenTimelock: string;
      protocolTreasury: string;
    };
  },
) {
  const totalSupply = parseUnits(
    config.token.totalSupplyWholeTokens.toString(),
    18,
  );
  const founderAmount = (totalSupply * config.token.founderBps) / 10_000n;
  const treasuryAmount = totalSupply - founderAmount;

  if (founderAmount <= 0n) throw new Error("Founder allocation is zero");
  if (treasuryAmount <= 0n) throw new Error("Treasury allocation is zero");

  await deployment.sethxToken.mint(
    deployment.addresses.founderTokenTimelock,
    founderAmount,
  );
  await deployment.sethxToken.mint(
    deployment.addresses.protocolTreasury,
    treasuryAmount,
  );
  await deployment.sethxToken.finishMinting();

  return {
    totalSupply,
    founderAmount,
    treasuryAmount,
  };
}
