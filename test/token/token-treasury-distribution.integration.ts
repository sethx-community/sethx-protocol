import { expect } from "chai";
import { id } from "ethers";
import { network } from "hardhat";
import { getLocalConfig } from "../../scripts/config/local.js";
import { deployTokenAndTreasury } from "../../scripts/deploy/00-deploy-token-and-treasury.js";
import { setupTokenDistribution } from "../../scripts/setup/10-token-distribution.js";

const { ethers, networkHelpers } = await network.create();

async function expectCustomError(
  action: () => Promise<unknown>,
  customErrorName: string,
) {
  const expectedSelector = id(`${customErrorName}()`).slice(0, 10);

  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const hasDecodedName = message.includes(customErrorName);
    const hasSelector = message.includes(expectedSelector);

    expect(
      hasDecodedName || hasSelector,
      `Expected custom error ${customErrorName} or selector ${expectedSelector}, but got: ${message}`,
    ).to.equal(true);

    return;
  }

  throw new Error(
    `Expected custom error ${customErrorName}, but transaction succeeded`,
  );
}

describe("Token, founder timelock, and treasury distribution", function () {
  it("deploys the production-style token and treasury flow locally", async function () {
    const founderAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const config = getLocalConfig(founderAddress);

    const deployment = await deployTokenAndTreasury(ethers, config);
    const distribution = await setupTokenDistribution(config, deployment);

    const token = deployment.sethxToken;
    const founderTimelock = deployment.founderTokenTimelock;

    expect(
      await token.balanceOf(deployment.addresses.founderTokenTimelock),
    ).to.equal(distribution.founderAmount);

    expect(
      await token.balanceOf(deployment.addresses.protocolTreasury),
    ).to.equal(distribution.treasuryAmount);

    expect(await token.totalSupply()).to.equal(distribution.totalSupply);
    expect(await token.mintingFinished()).to.equal(true);
    expect(await token.minter()).to.equal(ethers.ZeroAddress);

    await expectCustomError(() => token.mint(founderAddress, 1n), "NotMinter");

    expect(await founderTimelock.beneficiary()).to.equal(
      config.token.founderAddress,
    );
    expect(await founderTimelock.releasable()).to.equal(0n);

    await expectCustomError(
      () => founderTimelock.release(),
      "TokensStillLocked",
    );

    await networkHelpers.time.increaseTo(Number(deployment.founderReleaseTime));

    expect(await founderTimelock.releasable()).to.equal(
      distribution.founderAmount,
    );

    await founderTimelock.release();

    expect(await token.balanceOf(config.token.founderAddress)).to.equal(
      distribution.founderAmount,
    );

    expect(
      await token.balanceOf(deployment.addresses.founderTokenTimelock),
    ).to.equal(0n);

    await expectCustomError(
      () => founderTimelock.release(),
      "NoTokensToRelease",
    );
  });
});
