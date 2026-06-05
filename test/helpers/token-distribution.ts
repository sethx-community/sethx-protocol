import { expect } from "chai";

export async function expectTokenDistribution(
  token: any,
  deployment: {
    addresses: {
      founderTokenTimelock?: string;
      founderTokenTimelocks?: { address: string; allocation: string }[];
      protocolTreasury: string;
    };
  },
  distribution: {
    totalSupply: bigint;
    founderAmount: bigint;
    treasuryAmount: bigint;
  },
) {
  if (deployment.addresses.founderTokenTimelocks?.length) {
    let totalFounderBalance = 0n;
    for (const timelock of deployment.addresses.founderTokenTimelocks) {
      totalFounderBalance += await token.balanceOf(timelock.address);
    }
    expect(totalFounderBalance).to.equal(distribution.founderAmount);
  } else {
    if (!deployment.addresses.founderTokenTimelock) {
      throw new Error("missing founder token timelock address");
    }

    expect(
      await token.balanceOf(deployment.addresses.founderTokenTimelock),
    ).to.equal(distribution.founderAmount);
  }

  expect(await token.balanceOf(deployment.addresses.protocolTreasury)).to.equal(
    distribution.treasuryAmount,
  );

  expect(await token.totalSupply()).to.equal(distribution.totalSupply);
}
