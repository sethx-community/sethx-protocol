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
const LIQUIDATION_PRICE_UP = 2_250n * 10n ** PRICE_DECIMALS;
const INITIAL_MARGIN_BPS = 1_000n;
const FULL_MARGIN_BPS = 10_000n;
const MAINTENANCE_MARGIN_BPS = 500n;
const MULTIPLIER = 1n;
const SIZE = 10n ** 15n;
const FEE_CONTEXT_FUTURES = "Futures Trade";

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

const PositionSide = {
  None: 0n,
  Long: 1n,
  Short: 2n,
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

function isOpenPosition(p: any): boolean {
  return p.size > 0n && (p.side === PositionSide.Long || p.side === PositionSide.Short);
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

async function openMatchedPair(
  contracts: any,
  shortAccount: any,
  shortOwner: any,
  longAccount: any,
  longOwner: any,
  marketKey: string,
  price: bigint,
  size: bigint = SIZE,
) {
  await (
    await shortAccount
      .connect(shortOwner)
      .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, price, size, 0, ETH, ethers.ZeroAddress)
  ).wait();
  await (
    await longAccount
      .connect(longOwner)
      .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, price, size, 0, ETH, ethers.ZeroAddress)
  ).wait();
}

async function syncFuturesSettlement(contracts: any, oracle: any, oracleAddress: string, marketKey: string, price: bigint) {
  await (await oracle.setPrice(price)).wait();
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
  await (await contracts.futuresContract.syncSettlementPrice(marketKey)).wait();
  expect((await contracts.futuresContract.getMarket(marketKey)).lastSettlementPrice).to.equal(price);
}

describe("Futures lifecycle integration", function () {
  it("rejects malicious direct calls to futures core and orderbook mutating surfaces", async function () {
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
      contracts.futuresContract
        .connect(actors.attacker)
        .processTrade(attackerAddress, marketKey, PositionSide.Long, SIZE, 1n, INITIAL_PRICE),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).liquidatePosition(marketKey, attackerAddress),
    );
    await expectRevert(
      contracts.futuresContract.connect(actors.attacker).liquidateHead(marketKey, PositionSide.Long, 1n),
    );

    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setPassivePublisher(attackerAddress, true));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setPassivePool(marketKey, attackerAddress));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).clearPassiveSnapshot(marketKey));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setOrderLimits(1n, 1n));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).setImbalanceCallerFeeShareBps(1n));
    await expectRevert(
      contracts.futuresOrderBook
        .connect(actors.attacker)
        .placeOrder(marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress),
    );
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).cancelOrder(1n));
    await expectRevert(contracts.futuresOrderBook.connect(actors.attacker).matchImbalance(marketKey, 1n));
  });

  it("opens equal consolidated long and short futures positions through Accounts with exact margin, fees, and custody", async function () {
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
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, orderPrice, SIZE, 0, ETH, ethers.ZeroAddress)
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
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, orderPrice, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    makerOrder = await contracts.futuresOrderBook.ordersById(makerOrderId);
    const takerOrder = await contracts.futuresOrderBook.ordersById(takerOrderId);
    expect(makerOrder.orderId).to.equal(0n);
    expect(takerOrder.orderId).to.equal(0n);

    const makerShort = await contracts.futuresContract.getPosition(makerAddress, marketKey);
    const takerLong = await contracts.futuresContract.getPosition(takerAddress, marketKey);
    expect(isOpenPosition(makerShort)).to.equal(true);
    expect(isOpenPosition(takerLong)).to.equal(true);
    expect(makerShort.side).to.equal(PositionSide.Short);
    expect(takerLong.side).to.equal(PositionSide.Long);
    expect(makerShort.size).to.equal(SIZE);
    expect(takerLong.size).to.equal(SIZE);
    expect(makerShort.margin).to.equal(margin);
    expect(takerLong.margin).to.equal(margin);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.getOpenInterestImbalance(marketKey)).to.equal(0n);

    await expectEthState(contracts.vault, makerAddress, deposit - makerFee, margin, "maker filled");
    await expectEthState(contracts.vault, takerAddress, deposit - takerFee, margin, "taker filled");
    await expectVaultEthDelta(contracts, vaultBefore, [makerAddress, takerAddress]);
  });

  it("rebases winner and loser margins when an existing position mutates after settlement-price sync", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("FUT-B/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "FUT-B");

    const shortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    const longAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.dave);
    const newShortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const shortAddress = await shortAccount.getAddress();
    const longAddress = await longAccount.getAddress();
    const newShortAddress = await newShortAccount.getAddress();

    const deposit = 3n * WAD;
    await depositEthToAccount(shortAccount, actors.carol, deposit);
    await depositEthToAccount(longAccount, actors.dave, deposit);
    await depositEthToAccount(newShortAccount, actors.alice, deposit);

    await openMatchedPair(contracts, shortAccount, actors.carol, longAccount, actors.dave, marketKey, INITIAL_PRICE);

    const marginAtInitial = initialMarginRequired(SIZE, INITIAL_PRICE);
    const marginAtSettlement = initialMarginRequired(SIZE, SETTLEMENT_UP);
    const pnl = pnlFromSettlementMove(SIZE, INITIAL_PRICE, SETTLEMENT_UP);

    await syncFuturesSettlement(contracts, oracle, oracleAddress, marketKey, SETTLEMENT_UP);

    await (
      await newShortAccount
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, SETTLEMENT_UP, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();
    await (
      await longAccount
        .connect(actors.dave)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, SETTLEMENT_UP, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    const originalShort = await contracts.futuresContract.getPosition(shortAddress, marketKey);
    const longPosition = await contracts.futuresContract.getPosition(longAddress, marketKey);
    const newShort = await contracts.futuresContract.getPosition(newShortAddress, marketKey);

    expect(originalShort.side).to.equal(PositionSide.Short);
    expect(originalShort.margin, "old short is rebased as loser when winner mutates").to.equal(marginAtInitial - pnl);
    expect(originalShort.referencePrice).to.equal(SETTLEMENT_UP);

    expect(longPosition.side).to.equal(PositionSide.Long);
    expect(longPosition.size).to.equal(SIZE * 2n);
    expect(longPosition.margin, "long receives PnL then adds new opening margin").to.equal(marginAtInitial + pnl + marginAtSettlement);
    expect(longPosition.referencePrice).to.equal(SETTLEMENT_UP);

    expect(newShort.side).to.equal(PositionSide.Short);
    expect(newShort.margin).to.equal(marginAtSettlement);
    expect(await contracts.vault.settlementEthLocked(marketKey)).to.equal(0n);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(SIZE * 2n);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(SIZE * 2n);
  });

  it("uses close-aware consolidated mutation so reduce-only orders can close positions without new margin", async function () {
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

    await openMatchedPair(contracts, shortAccount, actors.alice, longAccount, actors.bob, marketKey, INITIAL_PRICE);

    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    expect(await contracts.vault.ethLocked(shortAddress)).to.equal(margin);
    expect(await contracts.vault.ethLocked(longAddress)).to.equal(margin);

    await (
      await shortAccount
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();
    await (
      await longAccount
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, INITIAL_PRICE, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    const shortClosed = await contracts.futuresContract.getPosition(shortAddress, marketKey);
    const longClosed = await contracts.futuresContract.getPosition(longAddress, marketKey);
    expect(isOpenPosition(shortClosed)).to.equal(false);
    expect(isOpenPosition(longClosed)).to.equal(false);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(0n);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(0n);
    expect(await contracts.vault.ethLocked(shortAddress)).to.equal(0n);
    expect(await contracts.vault.ethLocked(longAddress)).to.equal(0n);
  });


  it("indexes zero-liquidation-price longs as non-liquidatable instead of reverting", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    expect(await contracts.futuresContract.tickForLiquidationPrice(0n)).to.equal(0n);

    const fullMarginOracle = await deployMockOracle("FUT-ZERO-LIQ-A/USD", INITIAL_PRICE);
    const fullMarginOracleAddress = await registerFuturesOracle(
      contracts.priceManager,
      timelockSigner,
      fullMarginOracle,
    );
    const fullMarginMarketKey = await contracts.futuresContract.computeMarketKey(
      fullMarginOracleAddress,
    );

    await (
      await contracts.futuresContract
        .connect(timelockSigner)
        .createMarket(
          "FUT-ZERO-LIQ-A",
          fullMarginOracleAddress,
          FULL_MARGIN_BPS,
          MAINTENANCE_MARGIN_BPS,
          MULTIPLIER,
          INITIAL_PRICE,
        )
    ).wait();

    const fullShortAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );
    const fullLongAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.bob,
    );
    const fullLiquidatorAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.carol,
    );
    const fullShortAddress = await fullShortAccount.getAddress();
    const fullLongAddress = await fullLongAccount.getAddress();

    await depositEthToAccount(fullShortAccount, actors.alice, 5n * WAD);
    await depositEthToAccount(fullLongAccount, actors.bob, 5n * WAD);
    await depositEthToAccount(fullLiquidatorAccount, actors.carol, 5n * WAD);

    await openMatchedPair(
      contracts,
      fullShortAccount,
      actors.alice,
      fullLongAccount,
      actors.bob,
      fullMarginMarketKey,
      INITIAL_PRICE,
    );

    const fullLong = await contracts.futuresContract.getPosition(
      fullLongAddress,
      fullMarginMarketKey,
    );
    expect(fullLong.side).to.equal(PositionSide.Long);
    expect(fullLong.size).to.equal(SIZE);
    expect(fullLong.margin).to.equal(notionalFromRawPrice(SIZE, INITIAL_PRICE));
    expect(fullLong.liquidationPrice).to.equal(0n);
    expect(fullLong.liquidationTick).to.equal(0n);

    const fullLongNode = await contracts.futuresContract.getLiquidationNode(
      fullMarginMarketKey,
      fullLongAddress,
    );
    expect(fullLongNode.active).to.equal(true);
    expect(fullLongNode.side).to.equal(PositionSide.Long);
    expect(fullLongNode.liquidationPrice).to.equal(0n);
    expect(fullLongNode.liquidationTick).to.equal(0n);
    expect(
      await contracts.futuresContract.getLiquidationTickAnchor(
        fullMarginMarketKey,
        PositionSide.Long,
        0n,
      ),
    ).to.equal(fullLongAddress);

    const fullLongHealth = await contracts.futuresContract.positionHealth(
      fullMarginMarketKey,
      fullLongAddress,
    );
    expect(fullLongHealth.liquidatable).to.equal(false);

    await expectRevert(
      fullLiquidatorAccount
        .connect(actors.carol)
        .liquidateFuturesPosition(
          await contracts.futuresContract.getAddress(),
          fullMarginMarketKey,
          fullLongAddress,
        ),
    );

    await (
      await fullLiquidatorAccount
        .connect(actors.carol)
        .liquidateFuturesHead(
          await contracts.futuresContract.getAddress(),
          fullMarginMarketKey,
          PositionSide.Long,
          10n,
        )
    ).wait();

    expect(
      isOpenPosition(
        await contracts.futuresContract.getPosition(fullLongAddress, fullMarginMarketKey),
      ),
    ).to.equal(true);
    expect(
      isOpenPosition(
        await contracts.futuresContract.getPosition(fullShortAddress, fullMarginMarketKey),
      ),
    ).to.equal(true);

    const addMarginOracle = await deployMockOracle("FUT-ZERO-LIQ-B/USD", INITIAL_PRICE);
    const addMarginOracleAddress = await registerFuturesOracle(
      contracts.priceManager,
      timelockSigner,
      addMarginOracle,
    );
    const addMarginMarketKey = await createFuturesMarket(
      contracts,
      timelockSigner,
      addMarginOracleAddress,
      "FUT-ZERO-LIQ-B",
    );

    const addShortAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.dave,
    );
    const addLongAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.lp1,
    );
    const addLongAddress = await addLongAccount.getAddress();

    await depositEthToAccount(addShortAccount, actors.dave, 5n * WAD);
    await depositEthToAccount(addLongAccount, actors.lp1, 5n * WAD);

    await openMatchedPair(
      contracts,
      addShortAccount,
      actors.dave,
      addLongAccount,
      actors.lp1,
      addMarginMarketKey,
      INITIAL_PRICE,
    );

    const addLongBefore = await contracts.futuresContract.getPosition(
      addLongAddress,
      addMarginMarketKey,
    );
    expect(addLongBefore.liquidationPrice).to.be.gt(0n);

    const fullNotional = notionalFromRawPrice(SIZE, INITIAL_PRICE);
    await (
      await addLongAccount
        .connect(actors.lp1)
        .addFuturesMargin(
          await contracts.futuresContract.getAddress(),
          addMarginMarketKey,
          fullNotional - addLongBefore.margin,
        )
    ).wait();

    const addLongAfter = await contracts.futuresContract.getPosition(
      addLongAddress,
      addMarginMarketKey,
    );
    expect(addLongAfter.margin).to.equal(fullNotional);
    expect(addLongAfter.liquidationPrice).to.equal(0n);
    expect(addLongAfter.liquidationTick).to.equal(0n);

    const addLongNode = await contracts.futuresContract.getLiquidationNode(
      addMarginMarketKey,
      addLongAddress,
    );
    expect(addLongNode.active).to.equal(true);
    expect(addLongNode.liquidationPrice).to.equal(0n);
    expect(addLongNode.liquidationTick).to.equal(0n);
  });

  it("liquidates unsafe positions and matches resulting imbalance against standing user orders", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("FUT-D/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "FUT-D");

    const shortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const longAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const liquidatorAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    const sellerAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.dave);
    const matcherAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.lp1);

    const shortAddress = await shortAccount.getAddress();
    const longAddress = await longAccount.getAddress();
    const sellerAddress = await sellerAccount.getAddress();

    const deposit = 4n * WAD;
    await depositEthToAccount(shortAccount, actors.alice, deposit);
    await depositEthToAccount(longAccount, actors.bob, deposit);
    await depositEthToAccount(liquidatorAccount, actors.carol, deposit);
    await depositEthToAccount(sellerAccount, actors.dave, deposit);
    await depositEthToAccount(matcherAccount, actors.lp1, deposit);

    await openMatchedPair(contracts, shortAccount, actors.alice, longAccount, actors.bob, marketKey, INITIAL_PRICE);

    await syncFuturesSettlement(contracts, oracle, oracleAddress, marketKey, LIQUIDATION_PRICE_UP);

    await (
      await liquidatorAccount
        .connect(actors.carol)
        .liquidateFuturesPosition(
          await contracts.futuresContract.getAddress(),
          marketKey,
          shortAddress,
        )
    ).wait();

    const shortAfter = await contracts.futuresContract.getPosition(shortAddress, marketKey);
    expect(isOpenPosition(shortAfter)).to.equal(false);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(0n);
    expect(await contracts.futuresContract.getOpenInterestImbalance(marketKey)).to.equal(SIZE);
    expect(await contracts.vault.settlementEthLocked(marketKey)).to.be.gt(0n);

    const imbalanceBefore = await contracts.futuresContract.getImbalanceOrder(marketKey);
    expect(imbalanceBefore.active).to.equal(true);
    expect(imbalanceBefore.syntheticMakerSide).to.equal(PositionSide.Long);
    expect(imbalanceBefore.amount).to.equal(SIZE);
    expect(imbalanceBefore.settlementPrice).to.equal(LIQUIDATION_PRICE_UP);

    await (
      await sellerAccount
        .connect(actors.dave)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, LIQUIDATION_PRICE_UP, SIZE, 0, ETH, ethers.ZeroAddress)
    ).wait();

    await (
      await matcherAccount
        .connect(actors.lp1)
        .matchFuturesImbalance(
          await contracts.futuresOrderBook.getAddress(),
          marketKey,
          10n,
        )
    ).wait();

    const sellerPosition = await contracts.futuresContract.getPosition(sellerAddress, marketKey);
    expect(sellerPosition.side).to.equal(PositionSide.Short);
    expect(sellerPosition.size).to.equal(SIZE);
    expect(await contracts.futuresContract.totalLongs(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.totalShorts(marketKey)).to.equal(SIZE);
    expect(await contracts.futuresContract.getOpenInterestImbalance(marketKey)).to.equal(0n);

    const longPosition = await contracts.futuresContract.getPosition(longAddress, marketKey);
    expect(longPosition.side).to.equal(PositionSide.Long);
    expect(longPosition.size).to.equal(SIZE);
  });
});
