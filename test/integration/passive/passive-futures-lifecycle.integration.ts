import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { createNormalAccount } from "../helpers/accounts.js";
import { expectRevert } from "../helpers/reverts.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const WAD = 10n ** 18n;
const PRICE_DECIMALS = 8n;
const INITIAL_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const INITIAL_MARGIN_BPS = 1_000n;
const MAINTENANCE_MARGIN_BPS = 500n;
const MULTIPLIER = 1n;
const SIZE = 10n ** 15n;

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

const PositionSide = {
  None: 0n,
  Long: 1n,
  Short: 2n,
} as const;

function isOpenPosition(p: any): boolean {
  return p.size > 0n && (p.side === PositionSide.Long || p.side === PositionSide.Short);
}

function normalizePrice(rawPrice: bigint, oracleDecimals = 8n, marginDecimals = 18n): bigint {
  if (oracleDecimals === marginDecimals) return rawPrice;
  if (oracleDecimals < marginDecimals) return rawPrice * 10n ** (marginDecimals - oracleDecimals);
  return rawPrice / 10n ** (oracleDecimals - marginDecimals);
}

function initialMarginRequired(size: bigint, rawPrice: bigint): bigint {
  return (size * MULTIPLIER * normalizePrice(rawPrice) * INITIAL_MARGIN_BPS) / (10_000n * WAD);
}

async function deployMockOracle(pair: string, initialPrice: bigint) {
  const oracle = await ethers.deployContract("MockPriceOracle", [pair, 8, initialPrice]);
  await oracle.waitForDeployment();
  return oracle;
}

async function registerFuturesOracle(priceManager: any, governance: any, oracle: any) {
  const oracleAddress = await oracle.getAddress();

  if (!(await priceManager.isApprovedOracle(oracleAddress))) {
    await (await priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  }

  if (!(await priceManager.isOracleApprovedFor(oracleAddress, OracleContext.FUTURE_SETTLEMENT))) {
    await (
      await priceManager
        .connect(governance)
        .approveOracleForContext(oracleAddress, OracleContext.FUTURE_SETTLEMENT)
    ).wait();
  }

  await (await priceManager.syncOracleData(oracleAddress)).wait();
  expect(await priceManager.isOracleUsableForFutures(oracleAddress)).to.equal(true);

  return oracleAddress;
}

async function createFuturesMarket(contracts: any, timelockSigner: any, oracleAddress: string, label: string) {
  const marketKey = await contracts.futuresContract.computeMarketKey(oracleAddress);

  await (
    await contracts.futuresContract
      .connect(timelockSigner)
      .createMarket(
        label,
        oracleAddress,
        INITIAL_MARGIN_BPS,
        MAINTENANCE_MARGIN_BPS,
        MULTIPLIER,
        INITIAL_PRICE,
      )
  ).wait();

  const market = await contracts.futuresContract.getMarket(marketKey);
  expect(market.oracle).to.equal(oracleAddress);
  expect(market.lastSettlementPrice).to.equal(INITIAL_PRICE);
  expect(await contracts.futuresContract.marketActive(marketKey)).to.equal(true);

  return marketKey;
}

async function createMarketAndPool(contracts: any, timelockSigner: any, label: string) {
  const oracle = await deployMockOracle(`${label}/USD`, INITIAL_PRICE);
  const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
  const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, label);

  await (
    await contracts.passiveFuturesPoolFactory
      .connect(timelockSigner)
      .createPool(marketKey, await contracts.passiveFuturesSnapshotPublisher.getAddress())
  ).wait();

  const poolInfo = await contracts.passiveFuturesPoolFactory.poolForMarket(marketKey);
  const poolAddress = poolInfo.pool ?? poolInfo[0];
  expect(poolAddress).to.not.equal(ethers.ZeroAddress);
  expect(await contracts.futuresOrderBook.passivePoolForMarket(marketKey)).to.equal(poolAddress);
  expect(await contracts.accountRegistry.isAccount(poolAddress)).to.equal(true);

  const pool = await ethers.getContractAt("PassiveLiquidityPool", poolAddress);
  const snap = await pool.getSnapshot();
  expect(snap.registeredAccount).to.equal(true);
  expect(snap.marketKey).to.equal(marketKey);
  expect(snap.active).to.equal(true);
  expect(await contracts.passiveFuturesPoolFactory.isPoolActive(marketKey)).to.equal(true);

  return { oracle, oracleAddress, marketKey, pool, poolAddress };
}

async function depositEthToAccount(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function publishThroughTreasurer(
  contracts: any,
  treasurer: any,
  marketKey: string,
  bidPrice: bigint,
  bidSize: bigint,
  askPrice: bigint,
  askSize: bigint,
  validForBlocks: bigint,
  memo = "passive quote",
) {
  await (
    await contracts.passiveFuturesSnapshotPublisher
      .connect(treasurer)
      .publishPassiveSnapshot(
        marketKey,
        bidPrice,
        bidSize,
        askPrice,
        askSize,
        validForBlocks,
        memo,
      )
  ).wait();
}

async function setTreasurerPermissionsForTest(
  contracts: any,
  governor: any,
  treasurer: any,
  permissions: bigint,
  label: string,
) {
  const treasurerAddress = await treasurer.getAddress();

  if (await contracts.treasuryAuthority.isTreasurer(treasurerAddress)) {
    await (
      await contracts.treasuryAuthority
        .connect(governor)
        .setTreasurerPermissions(treasurerAddress, permissions)
    ).wait();
  } else {
    await (
      await contracts.treasuryAuthority
        .connect(governor)
        .appointTreasurer(treasurerAddress, label, permissions)
    ).wait();
  }
}

async function ensurePassiveQuoteTreasurerOperational(
  contracts: any,
  timelockSigner: any,
  treasurer: any,
) {
  const authority = contracts.treasuryAuthority;
  const treasurerAddress = await treasurer.getAddress();
  const passiveQuotePermission = await authority.PERMISSION_PUBLISH_PASSIVE_QUOTES();

  if (!(await authority.isTreasurer(treasurerAddress))) {
    await (
      await authority
        .connect(timelockSigner)
        .appointTreasurer(treasurerAddress, "passive quote integration treasurer", passiveQuotePermission)
    ).wait();
  } else {
    const currentPermissions = await authority.getTreasurerPermissions(treasurerAddress);
    if ((currentPermissions & passiveQuotePermission) !== passiveQuotePermission) {
      await (
        await authority
          .connect(timelockSigner)
          .setTreasurerPermissions(treasurerAddress, currentPermissions | passiveQuotePermission)
      ).wait();
    }
  }

  if (await authority.killed()) {
    await (await authority.connect(timelockSigner).unkillTreasury()).wait();
  }

  if (await authority.frozenTreasurers(treasurerAddress)) {
    await (await authority.connect(timelockSigner).unfreezeTreasurer(treasurerAddress)).wait();
  }

  expect(await authority.canCallAsTreasurer(treasurerAddress, passiveQuotePermission)).to.equal(
    true,
  );
}

async function expectPoolEthInvariant(contracts: any, poolAddress: string, label: string) {
  const total = await contracts.vault.ethBalances(poolAddress);
  const locked = await contracts.vault.ethLocked(poolAddress);
  const pool = await ethers.getContractAt("PassiveLiquidityPool", poolAddress);
  const snap = await pool.getSnapshot();

  expect(locked, `${label} locked <= total`).to.be.lte(total);
  expect(snap.totalEthBalance, `${label} snapshot total`).to.equal(total);
  expect(snap.lockedEthBalance, `${label} snapshot locked`).to.equal(locked);
  expect(snap.freeEthBalance, `${label} snapshot free`).to.equal(total - locked);
}

describe("Passive futures pool lifecycle integration", function () {
  it("rejects malicious direct calls to passive factory, publisher, orderbook, and pool admin surfaces", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    const attackerAddress = await actors.attacker.getAddress();

    const { marketKey, pool } = await createMarketAndPool(contracts, timelockSigner, "PF-SEC");

    await expectRevert(
      contracts.passiveFuturesPoolFactory
        .connect(actors.attacker)
        .createPool(marketKey, await contracts.passiveFuturesSnapshotPublisher.getAddress()),
    );
    await expectRevert(
      contracts.passiveFuturesPoolFactory
        .connect(actors.attacker)
        .approvePassivePublisher(attackerAddress, true),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.attacker)
        .setFuturesOrderBook(await contracts.futuresOrderBook.getAddress()),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.attacker)
        .publishPassiveSnapshot(marketKey, 0n, 0n, INITIAL_PRICE, SIZE, 10n, "bad"),
    );
    await expectRevert(
      contracts.futuresOrderBook
        .connect(actors.attacker)
        .publishPassiveSnapshot(marketKey, 0n, 0n, INITIAL_PRICE, SIZE, 10n),
    );
    await expectRevert(
      contracts.futuresOrderBook.connect(actors.attacker).setPassivePool(marketKey, attackerAddress),
    );
    await expectRevert(
      contracts.futuresOrderBook.connect(actors.attacker).setPassivePublisher(attackerAddress, true),
    );
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).clearPassiveSnapshot(marketKey));
    await expectRevert(contracts.passiveFuturesPoolFactory.connect(actors.attacker).closePool(marketKey));
    await expectRevert(contracts.passiveFuturesPoolFactory.connect(actors.attacker).reopenPool(marketKey));
    await expectRevert(contracts.passiveFuturesPoolFactory.connect(actors.attacker).setPoolActive(marketKey, false));
    await expectRevert(pool.connect(actors.attacker).setActive(false));
    await expectRevert(pool.connect(actors.attacker).setDepositsPaused(true));
    await expectRevert(pool.connect(actors.attacker).setWithdrawalsPaused(true));
  });

  it("lets passive-quote-only treasurers publish snapshots without liquidity permission", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const signers = await ethers.getSigners();
    const quoteOnlyTreasurer = signers[9];
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const { marketKey, pool, poolAddress } = await createMarketAndPool(
      contracts,
      timelockSigner,
      "PF-QUOTE-PERM",
    );

    await (await pool.connect(actors.lp1).deposit({ value: 1n * WAD })).wait();
    await expectPoolEthInvariant(contracts, poolAddress, "quote permission setup");

    const quotePermission = await contracts.treasuryAuthority.PERMISSION_PUBLISH_PASSIVE_QUOTES();
    await setTreasurerPermissionsForTest(
      contracts,
      timelockSigner,
      quoteOnlyTreasurer,
      quotePermission,
      "Passive quote publisher only",
    );

    await publishThroughTreasurer(
      contracts,
      quoteOnlyTreasurer,
      marketKey,
      0n,
      0n,
      INITIAL_PRICE,
      SIZE,
      10n,
      "quote-only treasurer can publish",
    );

    expect((await contracts.futuresOrderBook.passiveSnapshot(marketKey)).exists).to.equal(true);

    const liquidityPermission = await contracts.treasuryAuthority.PERMISSION_MANAGE_LIQUIDITY();
    await setTreasurerPermissionsForTest(
      contracts,
      timelockSigner,
      quoteOnlyTreasurer,
      liquidityPermission,
      "Liquidity manager only",
    );

    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(quoteOnlyTreasurer)
        .publishPassiveSnapshot(
          marketKey,
          0n,
          0n,
          INITIAL_PRICE,
          SIZE,
          10n,
          "liquidity-only treasurer cannot publish",
        ),
    );
  });

  it("lets public LPs deposit, request, cancel, and process withdrawals with exact share accounting and pause controls", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    const { pool, poolAddress } = await createMarketAndPool(contracts, timelockSigner, "PF-LP");

    const deposit = 2n * WAD;
    const previewShares = await pool.previewDeposit(deposit);
    expect(previewShares).to.equal(deposit);

    await (await pool.connect(actors.lp1).deposit({ value: deposit })).wait();
    expect(await pool.totalShares()).to.equal(deposit);
    expect(await pool.userShares(await actors.lp1.getAddress())).to.equal(deposit);
    expect(await contracts.vault.ethBalances(poolAddress)).to.equal(deposit);
    expect(await contracts.vault.ethLocked(poolAddress)).to.equal(0n);
    await expectPoolEthInvariant(contracts, poolAddress, "after deposit");

    await (await pool.connect(timelockSigner).setDepositsPaused(true)).wait();
    await expectRevert(pool.connect(actors.lp2).deposit({ value: 1n }));
    await (await pool.connect(timelockSigner).setDepositsPaused(false)).wait();

    const halfShares = deposit / 2n;
    await (await pool.connect(actors.lp1).requestWithdrawal(halfShares)).wait();
    let pending = await pool.pendingWithdrawal(await actors.lp1.getAddress());
    expect(pending.sharesPending ?? pending[0]).to.equal(halfShares);
    expect(await pool.totalPendingWithdrawalShares()).to.equal(halfShares);
    expect(await pool.userShares(await actors.lp1.getAddress())).to.equal(halfShares);

    await (await pool.connect(actors.lp1).cancelWithdrawalRequest()).wait();
    expect(await pool.totalPendingWithdrawalShares()).to.equal(0n);
    expect(await pool.userShares(await actors.lp1.getAddress())).to.equal(deposit);

    await (await pool.connect(actors.lp1).requestWithdrawal(halfShares)).wait();
    await (await pool.connect(timelockSigner).setWithdrawalsPaused(true)).wait();
    await expectRevert(pool.connect(actors.lp2).processWithdrawal(await actors.lp1.getAddress()));
    await (await pool.connect(timelockSigner).setWithdrawalsPaused(false)).wait();

    const vaultBefore = await contracts.vault.ethBalances(poolAddress);
    await (await pool.connect(actors.lp2).processWithdrawal(await actors.lp1.getAddress())).wait();
    expect(await contracts.vault.ethBalances(poolAddress)).to.equal(vaultBefore - halfShares);
    expect(await pool.totalShares()).to.equal(deposit - halfShares);
    expect(await pool.totalPendingWithdrawalShares()).to.equal(0n);
    await expectPoolEthInvariant(contracts, poolAddress, "after withdrawal");
  });

  it("validates passive snapshot publication, invalid inputs, and quote capacity", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    const { marketKey, pool, poolAddress } = await createMarketAndPool(contracts, timelockSigner, "PF-PUB");
    await ensurePassiveQuoteTreasurerOperational(contracts, timelockSigner, actors.treasurer);

    await (await pool.connect(actors.lp1).deposit({ value: 1n * WAD })).wait();
    await expectPoolEthInvariant(contracts, poolAddress, "before publishing");

    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(marketKey, 0n, 0n, INITIAL_PRICE, SIZE, 0n, "zero duration"),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(marketKey, 0n, 0n, 0n, 0n, 10n, "empty snapshot"),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(marketKey, INITIAL_PRICE, SIZE, INITIAL_PRICE, SIZE, 10n, "internal cross"),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(
          marketKey,
          0n,
          0n,
          INITIAL_PRICE,
          1000n * SIZE,
          10n,
          "too much capacity",
        ),
    );
    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(marketKey, 0n, 0n, INITIAL_PRICE, SIZE, 10n, ""),
    );

    await publishThroughTreasurer(
      contracts,
      actors.treasurer,
      marketKey,
      0n,
      0n,
      INITIAL_PRICE,
      SIZE,
      10n,
      "valid passive ask",
    );

    const snapshot = await contracts.futuresOrderBook.passiveSnapshot(marketKey);
    expect(snapshot.exists).to.equal(true);
    expect(snapshot.bestAsk.price).to.equal(INITIAL_PRICE);
    expect(snapshot.bestAsk.remainingSize).to.equal(SIZE);
  });

  it("fills a passive ask through a real Account and prevents withdrawals from draining locked collateral", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    const { marketKey, pool, poolAddress } = await createMarketAndPool(contracts, timelockSigner, "PF-FILL");
    await ensurePassiveQuoteTreasurerOperational(contracts, timelockSigner, actors.treasurer);

    const lpDeposit = 2n * WAD;
    await (await pool.connect(actors.lp1).deposit({ value: lpDeposit })).wait();

    await publishThroughTreasurer(
      contracts,
      actors.treasurer,
      marketKey,
      0n,
      0n,
      INITIAL_PRICE,
      SIZE,
      20n,
      "passive ask for taker buy",
    );

    const taker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const takerAddress = await taker.getAddress();
    await depositEthToAccount(taker, actors.bob, 2n * WAD);

    await (
      await taker
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    const poolShort = await contracts.futuresContract.getPosition(poolAddress, marketKey);
    const takerLong = await contracts.futuresContract.getPosition(takerAddress, marketKey);
    expect(isOpenPosition(poolShort)).to.equal(true);
    expect(poolShort.side).to.equal(PositionSide.Short);
    expect(isOpenPosition(takerLong)).to.equal(true);
    expect(takerLong.side).to.equal(PositionSide.Long);
    expect(poolShort.size).to.equal(SIZE);
    expect(takerLong.size).to.equal(SIZE);
    expect(poolShort.margin).to.equal(margin);
    expect(takerLong.margin).to.equal(margin);
    expect(await contracts.vault.ethLocked(poolAddress)).to.equal(margin);
    expect(await contracts.vault.ethLocked(takerAddress)).to.be.gte(margin);

    const snapshot = await contracts.futuresOrderBook.passiveSnapshot(marketKey);
    expect(snapshot.exists).to.equal(false);
    await expectPoolEthInvariant(contracts, poolAddress, "after passive fill");

    await (await pool.connect(actors.lp1).requestWithdrawal(lpDeposit)).wait();
    await (await pool.connect(actors.lp2).processWithdrawal(await actors.lp1.getAddress())).wait();

    const pending = await pool.pendingWithdrawal(await actors.lp1.getAddress());
    const sharesPending = pending.sharesPending ?? pending[0];
    expect(sharesPending, "locked collateral remains pending and cannot be drained").to.be.gt(0n);
    expect(await contracts.vault.ethLocked(poolAddress)).to.equal(margin);
    expect(await contracts.vault.ethBalances(poolAddress)).to.equal(margin);
    await expectPoolEthInvariant(contracts, poolAddress, "after partial withdrawal with locked collateral");
  });

  it("lets governance close passive pools and only allows inactive pools to publish reduce-only quotes", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    const { marketKey, pool, poolAddress } = await createMarketAndPool(contracts, timelockSigner, "PF-CLOSE");
    await ensurePassiveQuoteTreasurerOperational(contracts, timelockSigner, actors.treasurer);

    const lpDeposit = 2n * WAD;
    await (await pool.connect(actors.lp1).deposit({ value: lpDeposit })).wait();

    await publishThroughTreasurer(
      contracts,
      actors.treasurer,
      marketKey,
      0n,
      0n,
      INITIAL_PRICE,
      SIZE,
      20n,
      "active passive ask opens pool short",
    );

    const taker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const takerAddress = await taker.getAddress();
    await depositEthToAccount(taker, actors.bob, 2n * WAD);

    await (
      await taker
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    const poolShortBeforeClose = await contracts.futuresContract.getPosition(poolAddress, marketKey);
    expect(isOpenPosition(poolShortBeforeClose)).to.equal(true);
    expect(poolShortBeforeClose.side).to.equal(PositionSide.Short);
    expect(poolShortBeforeClose.size).to.equal(SIZE);

    await publishThroughTreasurer(
      contracts,
      actors.treasurer,
      marketKey,
      0n,
      0n,
      INITIAL_PRICE,
      SIZE,
      20n,
      "active passive ask before close",
    );
    expect((await contracts.futuresOrderBook.passiveSnapshot(marketKey)).exists).to.equal(true);

    await (await contracts.passiveFuturesPoolFactory.connect(timelockSigner).closePool(marketKey)).wait();

    const info = await contracts.passiveFuturesPoolFactory.poolForMarket(marketKey);
    expect(info.status ?? info[3]).to.equal(2n);
    expect(await contracts.passiveFuturesPoolFactory.isPoolActive(marketKey)).to.equal(false);
    expect(await pool.active()).to.equal(false);
    expect((await pool.getSnapshot()).active).to.equal(false);
    expect((await contracts.futuresOrderBook.passiveSnapshot(marketKey)).exists).to.equal(false);

    await expectRevert(pool.connect(actors.lp2).deposit({ value: 1n }));

    await (await pool.connect(actors.lp1).requestWithdrawal(lpDeposit / 4n)).wait();
    await (await pool.connect(actors.lp2).processWithdrawal(await actors.lp1.getAddress())).wait();

    await expectRevert(
      contracts.passiveFuturesSnapshotPublisher
        .connect(actors.treasurer)
        .publishPassiveSnapshot(marketKey, 0n, 0n, INITIAL_PRICE, SIZE, 20n, "inactive ask opens short"),
    );

    await publishThroughTreasurer(
      contracts,
      actors.treasurer,
      marketKey,
      INITIAL_PRICE,
      SIZE,
      0n,
      0n,
      20n,
      "inactive bid closes pool short",
    );

    await (
      await taker
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    const poolShortAfterClose = await contracts.futuresContract.getPosition(poolAddress, marketKey);
    const takerLongAfterClose = await contracts.futuresContract.getPosition(takerAddress, marketKey);
    expect(poolShortAfterClose.size).to.equal(0n);
    expect(takerLongAfterClose.size).to.equal(0n);
  });

});
