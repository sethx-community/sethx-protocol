import { parseUnits } from "ethers";

export async function setupTokenDistribution(
  parameters: {
    token: {
      totalSupplyWholeTokens: bigint;
      founderAllocationBps: bigint;
    };
  },
  deployment: {
    sethxToken: any;
    addresses: {
      founderTokenTimelock: string;
      protocolTreasury: string;
    };
  },
) {
  const totalSupply = parseUnits(
    parameters.token.totalSupplyWholeTokens.toString(),
    18,
  );

  const founderAmount =
    (totalSupply * parameters.token.founderAllocationBps) / 10_000n;

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
