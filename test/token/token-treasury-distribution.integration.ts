import { expect } from "chai";
import { network } from "hardhat";
import { readLocalDeployment } from "../helpers/deployment-reader.js";
import { expectCustomError } from "../helpers/assertions.js";

const { ethers, networkHelpers } = await network.create();

describe("Token, founder timelock, and treasury distribution", function () {
  it("verifies the local deployment token and treasury distribution", async function () {
    const deployment = readLocalDeployment();

    expect(deployment.environment).to.equal("local");
    expect(BigInt(deployment.chainId)).to.equal(31337n);

    const token = await ethers.getContractAt(
      "SethxToken",
      deployment.addresses.sethxToken,
    );

    const founderTimelock = await ethers.getContractAt(
      "FounderTokenTimelock",
      deployment.addresses.founderTokenTimelock,
    );

    const totalSupply = BigInt(deployment.tokenDistribution.totalSupply);
    const founderAmount = BigInt(deployment.tokenDistribution.founderAmount);
    const treasuryAmount = BigInt(deployment.tokenDistribution.treasuryAmount);

    expect(
      await token.balanceOf(deployment.addresses.founderTokenTimelock),
    ).to.equal(founderAmount);

    expect(
      await token.balanceOf(deployment.addresses.protocolTreasury),
    ).to.equal(treasuryAmount);

    expect(await token.totalSupply()).to.equal(totalSupply);
    expect(await token.mintingFinished()).to.equal(true);
    expect(await token.minter()).to.equal(ethers.ZeroAddress);

    await expectCustomError(
      () => token.mint(deployment.founderAddress, 1n),
      "NotMinter",
    );

    expect(await founderTimelock.beneficiary()).to.equal(
      deployment.founderAddress,
    );
    expect(await founderTimelock.releasable()).to.equal(0n);

    await expectCustomError(
      () => founderTimelock.release(),
      "TokensStillLocked",
    );

    await networkHelpers.time.increaseTo(
      Number(deployment.founderReleaseTime) + 1,
    );

    expect(await founderTimelock.releasable()).to.equal(founderAmount);

    await founderTimelock.release();

    expect(await token.balanceOf(deployment.founderAddress)).to.equal(
      founderAmount,
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
