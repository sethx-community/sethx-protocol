export async function setupTokenDistribution(
  parameters: {
    token: {
      totalSupply: bigint;
      founderAllocation: bigint;
      treasuryAllocation: bigint;
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
  const totalSupply = parameters.token.totalSupply;
  const founderAmount = parameters.token.founderAllocation;
  const treasuryAmount = parameters.token.treasuryAllocation;

  if (totalSupply <= 0n) throw new Error("Total supply is zero");
  if (founderAmount <= 0n) throw new Error("Founder allocation is zero");
  if (treasuryAmount <= 0n) throw new Error("Treasury allocation is zero");

  if (founderAmount + treasuryAmount !== totalSupply) {
    throw new Error(
      "Founder and treasury allocations do not sum to total supply",
    );
  }

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
