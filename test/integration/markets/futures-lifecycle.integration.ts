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
const SETTLEMENT_UP = 2_090n * 10n ** PRICE_DECIMALS;
const INITIAL_MARGIN_BPS = 1_000n;
const MAINTENANCE_MARGIN_BPS = 500n;
const MULTIPLIER = 1n;
const SIZE = 10n ** 15n;
const FEE_CONTEXT_FUTURES = "Futures Trade";

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

type FeeOutput = {
  fixedAmount: bigint;
  fixedToken: string;
  percentageAmount: bigint;
  percentageToken: string;
};

function normalizePrice(rawPrice: bigint, oracleDecimals = 8n, marginDecimals = 18n): bigint {
  if (oracleDecimals === marginDecimals) return rawPrice;
  if (oracleDecimals < marginDecimals) return rawPrice * 10n ** (marginDecimals - oracleDecimals);
  return rawPrice / 10n ** (oracleDecimals - marginDecimals);
}

function notionalFromRawPrice(size: bigint, rawPrice: bigint, multiplier = MULTIPLIER): bigint {
  return (size * multiplier * normalizePrice(rawPrice)) / WAD;
}

function initialMarginRequired(size: bigint, rawPrice: bigint): bigint {
  return (size * MULTIPLIER * normalizePrice(rawPrice) * INITIAL_MARGIN_BPS) / (10_000n * WAD);
}

function pnlFromSettlementMove(size: bigint, fromRaw: bigint, toRaw: bigint): bigint {
  const fromNorm = normalizePrice(fromRaw);
  const toNorm = normalizePrice(toRaw);
  const diff = fromNorm > toNorm ? fromNorm - toNorm : toNorm - fromNorm;
  return (size * MULTIPLIER * diff) / WAD;
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
  expect(market.initialMarginBps).to.equal(INITIAL_MARGIN_BPS);
  expect(market.maintenanceMarginBps).to.equal(MAINTENANCE_MARGIN_BPS);
  expect(market.multiplier).to.equal(MULTIPLIER);
  expect(market.lastSettlementPrice).to.equal(INITIAL_PRICE);
  expect(await contracts.futuresContract.marketActive(marketKey)).to.equal(true);

  return marketKey;
}

async function depositEthToAccount(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function getFuturesFee(feeManager: any, account: string, notional: bigint, isMaker: boolean): Promise<FeeOutput> {
  const fee = await feeManager.getFeeForAccount(
    ETH,
    ETH,
    notional,
    FEE_CONTEXT_FUTURES,
    account,
    isMaker,
  );

  return {
    fixedAmount: fee.fixedAmount,
    fixedToken: fee.fixedToken,
    percentageAmount: fee.percentageAmount,
    percentageToken: fee.percentageToken,
  };
}

function ethFeeAmount(fee: FeeOutput): bigint {
  let total = 0n;
  if (ethers.getAddress(fee.fixedToken) === ethers.getAddress(ETH)) total += fee.fixedAmount;
  if (ethers.getAddress(fee.percentageToken) === ethers.getAddress(ETH)) total += fee.percentageAmount;
  return total;
}

async function ethState(vault: any, account: string) {
  return {
    total: await vault.ethBalances(account),
    locked: await vault.ethLocked(account),
  };
}

async function expectEthState(vault: any, account: string, expectedTotal: bigint, expectedLocked: bigint, label: string) {
  const actual = await ethState(vault, account);
  expect(actual.total, `${label} ETH total`).to.equal(expectedTotal);
  expect(actual.locked, `${label} ETH locked`).to.equal(expectedLocked);
  expect(actual.locked, `${label} locked <= total`).to.be.lte(actual.total);
}

async function expectVaultEthDelta(contracts: any, before: bigint, accounts: string[]) {
  let internal = await contracts.vault.treasuryEthBalance();
  internal += await contracts.vault.settlementEthLocked(ethers.ZeroHash);
  for (const account of accounts) internal += await contracts.vault.ethBalances(account);

  const currentVaultEth = await ethers.provider.getBalance(await contracts.vault.getAddress());
  expect(currentVaultEth, "vault ETH custody must cover tracked futures accounts and pre-existing ETH").to.be.gte(internal);
  expect(currentVaultEth, "vault ETH balance should not drop below baseline during futures scenario").to.be.gte(before);
}

describe("Futures lifecycle integration", function () {
  it("rejects malicious direct calls to futures core, orderbook, and settlement mutating surfaces", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attackerAddress = await actors.attacker.getAddress();
    const marketKey = ethers.keccak256(ethers.toUtf8Bytes("malicious-futures-market"));

    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .setPriceManager(await contracts.priceManager.getAddress()),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .setOrderBook(await contracts.futuresOrderBook.getAddress()),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .setSettlementManager(await contracts.settlementManager.getAddress()),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .createMarket("BAD", attackerAddress, 1_000n, 500n, 1n, INITIAL_PRICE),
    );
    await expectRevert(contracts.futuresContract.connect(actors.attacker).closeMarket(marketKey));
    await expectRevert(contracts.futuresContract.connect(actors.attacker).reopenMarket(marketKey));
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .setMarketRiskParams(marketKey, 1_000n, 500n, 1n),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).setLastSettlementPrice(marketKey, INITIAL_PRICE),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .openPosition(attackerAddress, marketKey, SIZE, 1n, true),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).reducePosition(attackerAddress, marketKey, SIZE, true),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).adjustMargin(attackerAddress, marketKey, true, 1n),
    );
    await expectRevert(contracts.futuresContract.connect(actors.attacker).netPositions(marketKey));
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).netPositionsFor(attackerAddress, marketKey),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .settlePosition(marketKey, attackerAddress, true, INITIAL_PRICE),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .settlePositionCapped(marketKey, attackerAddress, true, INITIAL_PRICE, 1n),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .settlePositionCredit(marketKey, attackerAddress, true, 1n),
    );
    await expectRevert(
      contracts.futuresContract
        .connect(actors.attacker)
        .liquidatePosition(marketKey, attackerAddress, true, INITIAL_PRICE),
    );
    await expectRevert(contracts.futuresContract.connect(actors.attacker).useLiquidationBuffer(marketKey, 1n));
    await expectRevert(contracts.futuresContract.connect(actors.attacker).useImbalanceBuffer(marketKey, 1n));
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).fundImbalanceBuffer(marketKey, 1n, "bad"),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).fundLiquidationBuffer(marketKey, 1n, "bad"),
    );

    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setSettlementManager(attackerAddress));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setPassivePublisher(attackerAddress, true));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setPassivePool(marketKey, attackerAddress));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).clearPassiveSnapshot(marketKey));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setOrderLimits(1n, 1n));
    await expectRevert(
      contracts.futuresOrderBook
        .connect(actors.attacker)
        .placeOrder(marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH),
    );
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).cancelOrder(1n));
    await expectRevert(
      contracts.futuresOrderBook
        .connect(actors.attacker)
        .replaceSyntheticImbalanceOrder(marketKey, true, 0, SIZE, INITIAL_PRICE),
    );

    await expectRevert(contracts.settlementManager.connect(actors.attacker).setOrderBook(await contracts.futuresOrderBook.getAddress()));
    await expectRevert(contracts.settlementManager.connect(actors.attacker).stepCollectLoserLosses(marketKey, 10n));
    await expectRevert(contracts.settlementManager.connect(actors.attacker).stepPayWinnerProfits(marketKey, 10n));
    await expectRevert(contracts.settlementManager.connect(actors.attacker).finalizeSettlement(marketKey));
    await expectRevert(contracts.settlementManager.connect(actors.attacker).settleAll(marketKey));
  });

  it("opens equal long and short futures positions through Accounts with exact margin, fees, and custody", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("FUT-A/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "FUT-A");

    const maker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const taker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const makerAddress = await maker.getAddress();
    const takerAddress = await taker.getAddress();

    const deposit = 2n * WAD;
    await depositEthToAccount(maker, actors.alice, deposit);
    await depositEthToAccount(taker, actors.bob, deposit);

    const vaultBefore = await ethers.provider.getBalance(await contracts.vault.getAddress());
    const orderPrice = INITIAL_PRICE;
    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    const notional = notionalFromRawPrice(SIZE, orderPrice);
    const makerFee = ethFeeAmount(await getFuturesFee(contracts.feeManager, makerAddress, notional, true));
    const takerFee = ethFeeAmount(await getFuturesFee(contracts.feeManager, takerAddress, notional, false));

    const makerOrderId = await contracts.futuresOrderBook.nextOrderId();
    await (
      await maker
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, orderPrice, SIZE, 0, ETH)
    ).wait();

    let makerOrder = await contracts.futuresOrderBook.ordersById(makerOrderId);
    expect(makerOrder.user).to.equal(makerAddress);
    expect(makerOrder.amount).to.equal(SIZE);
    expect(makerOrder.marginLocked).to.equal(margin);
    await expectEthState(contracts.vault, makerAddress, deposit, margin + makerFee, "maker resting");

    const takerOrderId = await contracts.futuresOrderBook.nextOrderId();
    await (
      await taker
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, orderPrice, SIZE, 0, ETH)
    ).wait();

    makerOrder = await contracts.futuresOrderBook.ordersById(makerOrderId);
    const takerOrder = await contracts.futuresOrderBook.ordersById(takerOrderId);
    expect(makerOrder.orderId).to.equal(0n);
    expect(takerOrder.orderId).to.equal(0n);

    const makerShort = await contracts.futuresContract.getPosition(makerAddress, marketKey, false);
    const takerLong = await contracts.futuresContract.getPosition(takerAddress, marketKey, true);
    expect(makerShort.isActive).to.equal(true);
    expect(takerLong.isActive).to.equal(true);
    expect(makerShort.size).to.equal(SIZE);
    expect(takerLong.size).to.equal(SIZE);
    expect(makerShort.margin).to.equal(margin);
    expect(takerLong.margin).to.equal(margin);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(SIZE);

    await expectEthState(contracts.vault, makerAddress, deposit - makerFee, margin, "maker filled");
    await expectEthState(contracts.vault, takerAddress, deposit - takerFee, margin, "taker filled");
    await expectVaultEthDelta(contracts, vaultBefore, [makerAddress, takerAddress]);
  });

  it("settles adverse futures drift through SettlementManager using oracle last price and exact PnL movement", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("FUT-B/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "FUT-B");

    const shortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    const longAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.dave);
    const shortAddress = await shortAccount.getAddress();
    const longAddress = await longAccount.getAddress();

    const deposit = 2n * WAD;
    await depositEthToAccount(shortAccount, actors.carol, deposit);
    await depositEthToAccount(longAccount, actors.dave, deposit);

    await (
      await shortAccount
        .connect(actors.carol)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();
    await (
      await longAccount
        .connect(actors.dave)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();

    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    const pnl = pnlFromSettlementMove(SIZE, INITIAL_PRICE, SETTLEMENT_UP);

    await (await oracle.setPrice(SETTLEMENT_UP)).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
    await (await contracts.settlementManager.connect(actors.deployer).settleAll(marketKey)).wait();

    const market = await contracts.futuresContract.getMarket(marketKey);
    expect(market.lastSettlementPrice).to.equal(SETTLEMENT_UP);

    const shortPosition = await contracts.futuresContract.getPosition(shortAddress, marketKey, false);
    const longPosition = await contracts.futuresContract.getPosition(longAddress, marketKey, true);
    expect(shortPosition.margin, "short loses margin on upward settlement").to.equal(margin - pnl);
    expect(longPosition.margin, "long receives credited settlement PnL").to.equal(margin + pnl);
    expect(await contracts.vault.ethLocked(shortAddress)).to.equal(margin - pnl);
    expect(await contracts.vault.ethLocked(longAddress)).to.equal(margin + pnl);
    expect(await contracts.vault.settlementEthLocked(marketKey)).to.equal(0n);
  });

  it("uses close-aware netting so reduce-only orders can close positions without new margin", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("FUT-C/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "FUT-C");

    const shortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const longAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const shortAddress = await shortAccount.getAddress();
    const longAddress = await longAccount.getAddress();

    const deposit = 2n * WAD;
    await depositEthToAccount(shortAccount, actors.alice, deposit);
    await depositEthToAccount(longAccount, actors.bob, deposit);

    await (
      await shortAccount
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();
    await (
      await longAccount
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();

    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    expect(await contracts.vault.ethLocked(shortAddress)).to.equal(margin);
    expect(await contracts.vault.ethLocked(longAddress)).to.equal(margin);

    await (
      await shortAccount
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();
    await (
      await longAccount
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, INITIAL_PRICE, SIZE, 0, ETH)
    ).wait();

    const shortClosed = await contracts.futuresContract.getPosition(shortAddress, marketKey, false);
    const longClosed = await contracts.futuresContract.getPosition(longAddress, marketKey, true);
    expect(shortClosed.isActive).to.equal(false);
    expect(longClosed.isActive).to.equal(false);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(0n);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(0n);
    expect(await contracts.vault.ethLocked(shortAddress)).to.equal(0n);
    expect(await contracts.vault.ethLocked(longAddress)).to.equal(0n);
  });
});
