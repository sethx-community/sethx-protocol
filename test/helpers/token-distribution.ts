import { expect } from "chai";

export async function expectTokenDistribution(
  token: any,
  deployment: {
    addresses: {
      founderTokenTimelock: string;
      protocolTreasury: string;
    };
  },
  distribution: {
    totalSupply: bigint;
    founderAmount: bigint;
    treasuryAmount: bigint;
  },
) {
  expect(
    await token.balanceOf(deployment.addresses.founderTokenTimelock),
  ).to.equal(distribution.founderAmount);

  expect(await token.balanceOf(deployment.addresses.protocolTreasury)).to.equal(
    distribution.treasuryAmount,
  );

  expect(await token.totalSupply()).to.equal(distribution.totalSupply);
}
