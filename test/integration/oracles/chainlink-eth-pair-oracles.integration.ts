import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const WAD = 10n ** 18n;

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new Error("latest block unavailable");
  return BigInt(block.timestamp);
}

describe("Chainlink token/ETH price oracles", function () {
  it("fetches and normalizes USDC/ETH from an immutable Chainlink-style feed", async function () {
    const [admin, keeper] = await ethers.getSigners();
    const feed = await ethers.deployContract("MockChainlinkAggregatorV3", [18, 500000000000000n]);
    await feed.waitForDeployment();

    const oracle = await ethers.deployContract("ChainlinkUsdcEthOracle", [
      await admin.getAddress(),
      await feed.getAddress(),
      3600,
    ]);
    await oracle.waitForDeployment();

    await (await oracle.connect(keeper).fetchPrice()).wait();

    const last = await oracle.getLastPrice();
    expect(last.price).to.equal(500000000000000n);
    expect(last.timestamp).to.be.greaterThan(0n);
    expect(last.lastFetchTimestamp).to.be.greaterThanOrEqual(await latestTimestamp() - 1n);
    expect(last.status).to.equal("OK");
    expect(await oracle.decimals()).to.equal(18);
    expect(await oracle.feed()).to.equal(await feed.getAddress());
    expect(await oracle.fetchFormula()).to.contain("feed.latestRoundData()");
  });

  it("fetches and normalizes WBTC/ETH from an 8-decimal Chainlink-style feed", async function () {
    const [admin] = await ethers.getSigners();
    const feed = await ethers.deployContract("MockChainlinkAggregatorV3", [8, 1550000000]);
    await feed.waitForDeployment();

    const oracle = await ethers.deployContract("ChainlinkWbtcEthOracle", [
      await admin.getAddress(),
      await feed.getAddress(),
      3600,
    ]);
    await oracle.waitForDeployment();

    await (await oracle.fetchPrice()).wait();

    const last = await oracle.getLastPrice();
    expect(last.price).to.equal(1550000000n * 10n ** 10n);
    expect(last.price).to.equal(15_500_000_000_000_000_000n);
    expect(last.status).to.equal("OK");
  });

  it("rejects stale Chainlink rounds inside the oracle without PriceManager changes", async function () {
    const [admin] = await ethers.getSigners();
    const feed = await ethers.deployContract("MockChainlinkAggregatorV3", [18, WAD]);
    await feed.waitForDeployment();

    const oracle = await ethers.deployContract("ChainlinkUsdcEthOracle", [
      await admin.getAddress(),
      await feed.getAddress(),
      60,
    ]);
    await oracle.waitForDeployment();

    await feed.setRoundData(1, WAD, 1, 1, 1);
    await expect(oracle.fetchPrice()).to.be.revertedWithCustomError(oracle, "StalePrice");
  });
});
