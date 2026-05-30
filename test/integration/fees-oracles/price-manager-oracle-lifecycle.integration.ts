import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";

import { impersonateTimelock } from "../helpers/governance.js";
import { deployMockAssets } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";

const { ethers } = await network.create();

const OracleStatus = {
  OK: 0,
  DEGRADED: 1,
  FROZEN: 2,
  PENDING: 3,
  STALE: 4,
} as const;

const OracleContext = {
  GENERAL: 0,
  TRADE_VALUE: 1,
  FUTURE_SETTLEMENT: 2,
  COLLATERAL_EVAL: 3,
  OPTION_SETTLEMENT: 4,
  FEE_CONVERSION: 5,
} as const;

const WAD = 10n ** 18n;
const PRICE_10_USD_8 = 10n * 10n ** 8n;
const PRICE_25_USD_8 = 25n * 10n ** 8n;

async function latestBlockTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new Error("latest block unavailable");
  return BigInt(block.timestamp);
}


async function refreshOracle(priceManager: any, oracleAddress: string) {
  await (await priceManager.syncOracleData(oracleAddress)).wait();
}

async function deployMockOracle(
  pair: string,
  decimals: number,
  initialPrice: bigint,
) {
  const oracle = await ethers.deployContract("MockPriceOracle", [
    pair,
    decimals,
    initialPrice,
  ]);
  await oracle.waitForDeployment();
  return oracle;
}

async function registerMockOracleForTokenContext(
  priceManager: any,
  governance: any,
  token: string,
  oracle: any,
  context: number,
  label: string,
) {
  const oracleAddress = await oracle.getAddress();

  await (
    await priceManager.connect(governance).approveOracle(oracleAddress)
  ).wait();
  await (
    await priceManager
      .connect(governance)
      .approveOracleForContext(oracleAddress, context)
  ).wait();
  await (
    await priceManager
      .connect(governance)
      .setOracleMetadata(
        oracleAddress,
        token,
        label,
        "Local integration oracle",
      )
  ).wait();
  await (
    await priceManager
      .connect(governance)
      .setTokenAllowedForContext(token, context, true)
  ).wait();
  await (
    await priceManager
      .connect(governance)
      .registerOracleForTokenContext(token, context, oracleAddress)
  ).wait();

  return oracleAddress;
}

describe("PriceManager oracle registration and freshness integration", function () {
  it("rejects malicious governance calls to every PriceManager mutating admin function", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);
    const oracle = await deployMockOracle("MTKA/USD", 8, PRICE_10_USD_8);

    const attackerAddress = await actors.attacker.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();
    const oracleAddress = await oracle.getAddress();

    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        "setStaleTimeout",
        () =>
          contracts.priceManager.connect(actors.attacker).setStaleTimeout(600),
      ],
      [
        "approveOracle",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .approveOracle(oracleAddress),
      ],
      [
        "removeOracle",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .removeOracle(oracleAddress),
      ],
      [
        "approveOracleForContext",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .approveOracleForContext(oracleAddress, OracleContext.TRADE_VALUE),
      ],
      [
        "revokeOracleForContext",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .revokeOracleForContext(oracleAddress, OracleContext.TRADE_VALUE),
      ],
      [
        "setOracleStatus",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .setOracleStatus(oracleAddress, OracleStatus.OK),
      ],
      [
        "setOracleMetadata",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .setOracleMetadata(oracleAddress, tokenAddress, "Bad", "Bad"),
      ],
      [
        "setTokenAllowedForContext",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .setTokenAllowedForContext(
              tokenAddress,
              OracleContext.TRADE_VALUE,
              true,
            ),
      ],
      [
        "registerOracleForTokenContext",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .registerOracleForTokenContext(
              tokenAddress,
              OracleContext.TRADE_VALUE,
              oracleAddress,
            ),
      ],
      [
        "removeOracleForTokenContext",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .removeOracleForTokenContext(
              tokenAddress,
              OracleContext.TRADE_VALUE,
              oracleAddress,
            ),
      ],
      [
        "grantRole",
        () =>
          contracts.priceManager
            .connect(actors.attacker)
            .grantRole(ethers.ZeroHash, attackerAddress),
      ],
    ];

    for (const [, call] of calls) {
      await expectRevert(call());
    }

    expect(
      await contracts.priceManager.isApprovedOracle(oracleAddress),
    ).to.equal(false);
    expect(
      await contracts.priceManager.tokenAllowedForContext(
        tokenAddress,
        OracleContext.TRADE_VALUE,
      ),
    ).to.equal(false);
  });

  it("validates the deployed SETHX fee-conversion oracle registration and current usability", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);

    const oracleAddress = addresses.sethxFeeConversionOracle;
    const context = OracleContext.FEE_CONVERSION;

    expect(
      await contracts.priceManager.isApprovedOracle(oracleAddress),
    ).to.equal(true);
    expect(
      await contracts.priceManager.isOracleApprovedFor(oracleAddress, context),
    ).to.equal(true);
    expect(
      await contracts.priceManager.tokenAllowedForContext(
        addresses.sethxToken,
        context,
      ),
    ).to.equal(true);

    const registered = await contracts.priceManager.getOraclesForTokenContext(
      addresses.sethxToken,
      context,
    );
    expect(
      registered.map((addr: string) => ethers.getAddress(addr)),
      "SETHX fee oracle must be registered for FEE_CONVERSION",
    ).to.include(ethers.getAddress(oracleAddress));

    await refreshOracle(contracts.priceManager, oracleAddress);

    const usable =
      await contracts.priceManager.isOracleUsableForFeeConversion(
        oracleAddress,
      );
    expect(usable).to.equal(true);

    const [rate, selectedOracle] =
      await contracts.priceManager.getFeeConversionRate(addresses.sethxToken);
    expect(selectedOracle).to.equal(oracleAddress);
    expect(rate).to.equal(
      await contracts.sethxFeeConversionOracle.sethxPerEth(),
    );

    const ethFee = ethers.parseEther("0.125");
    const converted = await contracts.priceManager.convertEthFeeToToken(
      addresses.sethxToken,
      ethFee,
    );
    expect(converted).to.equal((ethFee * rate) / WAD);

    // The SETHX fee-conversion oracle is a static governance-set rate.
    // Fee conversion must remain usable even when it does not produce a
    // fresh daily market snapshot. Daily snapshot freshness is tested below
    // with normal mock market oracles.
  });

  it("registers mock trade-value oracles through governance and reconciles token conversion exactly", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const assets = await deployMockAssets(ethers);
    const governance = await impersonateTimelock(
      ethers,
      addresses.sethxTimelock,
    );

    const tokenA = await assets.tokenA.getAddress();
    const tokenB = await assets.tokenB.getAddress();
    const oracleA = await deployMockOracle("MTKA/USD", 8, PRICE_10_USD_8);
    const oracleB = await deployMockOracle("MTKB/USD", 8, PRICE_25_USD_8);

    const oracleAAddress = await registerMockOracleForTokenContext(
      contracts.priceManager,
      governance,
      tokenA,
      oracleA,
      OracleContext.TRADE_VALUE,
      "MTKA/USD",
    );
    const oracleBAddress = await registerMockOracleForTokenContext(
      contracts.priceManager,
      governance,
      tokenB,
      oracleB,
      OracleContext.TRADE_VALUE,
      "MTKB/USD",
    );

    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleAAddress,
        OracleContext.TRADE_VALUE,
      ),
      "newly registered oracle must not be usable before sync",
    ).to.equal(false);

    await (await contracts.priceManager.syncOracleData(oracleAAddress)).wait();
    await (await contracts.priceManager.syncOracleData(oracleBAddress)).wait();

    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleAAddress,
        OracleContext.TRADE_VALUE,
      ),
    ).to.equal(true);
    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleBAddress,
        OracleContext.TRADE_VALUE,
      ),
    ).to.equal(true);

    const [okA, selectedA] =
      await contracts.priceManager.getUsableOracleForTokenContext(
        tokenA,
        OracleContext.TRADE_VALUE,
      );
    expect(okA).to.equal(true);
    expect(selectedA).to.equal(oracleAAddress);

    const priceA = await contracts.priceManager.getOraclePriceInEth(
      oracleAAddress,
      OracleContext.TRADE_VALUE,
    );
    const priceB = await contracts.priceManager.getOraclePriceInEth(
      oracleBAddress,
      OracleContext.TRADE_VALUE,
    );
    expect(priceA).to.equal(10n * WAD);
    expect(priceB).to.equal(25n * WAD);

    const assetAmount = ethers.parseEther("100");
    const converted = await contracts.priceManager.getConvertedValue(
      oracleAAddress,
      assetAmount,
      oracleBAddress,
    );
    expect(converted).to.equal(ethers.parseEther("40"));

    const metadata =
      await contracts.priceManager.getOracleMetadata(oracleAAddress);
    expect(metadata.token).to.equal(tokenA);
    expect(metadata.label).to.equal("MTKA/USD");

    const tokenAOracles =
      await contracts.priceManager.getOraclesForToken(tokenA);
    expect(
      tokenAOracles.map((addr: string) => ethers.getAddress(addr)),
    ).to.include(ethers.getAddress(oracleAAddress));
  });

  it("enforces status and stale-time freshness boundaries for registered mock oracles", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const assets = await deployMockAssets(ethers);
    const governance = await impersonateTimelock(
      ethers,
      addresses.sethxTimelock,
    );

    const tokenA = await assets.tokenA.getAddress();
    const oracle = await deployMockOracle("MTKA/USD", 8, PRICE_10_USD_8);
    const oracleAddress = await registerMockOracleForTokenContext(
      contracts.priceManager,
      governance,
      tokenA,
      oracle,
      OracleContext.TRADE_VALUE,
      "MTKA/USD",
    );

    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      ),
    ).to.equal(true);

    const staleTimeout = await contracts.priceManager.staleTimeout();
    const now = await latestBlockTimestamp();
    const staleTimestamp =
      now > staleTimeout + 10n ? now - staleTimeout - 10n : 1n;

    await (
      await oracle.setPriceWithTimestamp(
        PRICE_10_USD_8,
        staleTimestamp,
        staleTimestamp,
        "OK",
      )
    ).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();

    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      ),
      "OK status with timestamp older than staleTimeout must be unusable",
    ).to.equal(false);

    const [okWhenStale, priceWhenStale] =
      await contracts.priceManager.tryGetOraclePriceInEth(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      );
    expect(okWhenStale).to.equal(false);
    expect(priceWhenStale).to.equal(0n);
    await expectRevert(
      contracts.priceManager.getOraclePriceInEth(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      ),
    );

    const freshTimestamp = await latestBlockTimestamp();
    await (
      await oracle.setPriceWithTimestamp(
        PRICE_10_USD_8,
        freshTimestamp,
        freshTimestamp,
        "STALE",
      )
    ).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();

    const [, , , staleStatus] = await contracts.priceManager.getOraclePrice(
      oracleAddress,
      OracleContext.TRADE_VALUE,
    );
    expect(staleStatus).to.equal(OracleStatus.STALE);
    expect(
      await contracts.priceManager.isOracleUsableForContext(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      ),
      "fresh timestamp with STALE status must be unusable",
    ).to.equal(false);

    await (await oracle.setPrice(PRICE_25_USD_8)).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();

    const [okAfterRecovery, recoveredPrice] =
      await contracts.priceManager.tryGetOraclePriceInEth(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      );
    expect(okAfterRecovery).to.equal(true);
    expect(recoveredPrice).to.equal(25n * WAD);
  });

  it("rejects unusable and unregistered oracle pricing paths without changing deployed setup", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const assets = await deployMockAssets(ethers);
    const unregisteredOracle = await deployMockOracle(
      "UNREGISTERED/USD",
      8,
      PRICE_10_USD_8,
    );

    const tokenAddress = await assets.tokenA.getAddress();
    const oracleAddress = await unregisteredOracle.getAddress();

    await expectRevert(
      contracts.priceManager.getOraclePrice(
        ethers.ZeroAddress,
        OracleContext.TRADE_VALUE,
      ),
    );
    await expectRevert(
      contracts.priceManager.fetchPrice(ethers.ZeroAddress),
    );
    await expectRevert(
      contracts.priceManager.syncOracleData(ethers.ZeroAddress),
    );
    await expectRevert(
      contracts.priceManager.getOraclePrice(
        oracleAddress,
        OracleContext.TRADE_VALUE,
      ),
    );
    await expectRevert(contracts.priceManager.fetchPrice(oracleAddress));
    await expectRevert(contracts.priceManager.syncOracleData(oracleAddress));

    const [ok, selectedOracle] =
      await contracts.priceManager.getUsableOracleForTokenContext(
        tokenAddress,
        OracleContext.TRADE_VALUE,
      );
    expect(ok).to.equal(false);
    expect(selectedOracle).to.equal(ethers.ZeroAddress);

    await expectRevert(
      contracts.priceManager.getFeeConversionRate(tokenAddress),
    );
    await expectRevert(
      contracts.priceManager.convertEthFeeToToken(
        tokenAddress,
        ethers.parseEther("1"),
      ),
    );
  });
});
