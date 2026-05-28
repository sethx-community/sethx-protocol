import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import {
  createLendingAccount,
  createNormalAccount,
} from "../helpers/accounts.js";
import { deployMockAssets, mintMockBalances } from "../helpers/mock-assets.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;
const PRICE_DECIMALS = 8n;
const FUTURES_INITIAL_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const FUTURES_STRESS_PRICE = 2_350n * 10n ** PRICE_DECIMALS;
const INITIAL_MARGIN_BPS = 1_000n;
const MAINTENANCE_MARGIN_BPS = 500n;
const MULTIPLIER = 1n;
const FUTURES_SIZE = 10n ** 15n;
const LENDING_RISK_LEVEL = 2;
const LENDING_RATE_BPS = 1_000n;

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(days = 14): Promise<bigint> {
  return (await latestTimestamp()) + BigInt(days) * 24n * 60n * 60n;
}

function lastFridayAtNoonUtc(year: number, monthOneBased: number): bigint {
  const firstNextMonth =
    monthOneBased === 12
      ? Date.UTC(year + 1, 0, 1, 0, 0, 0)
      : Date.UTC(year, monthOneBased, 1, 0, 0, 0);

  const d = new Date(firstNextMonth - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

async function nextLendingExpiry(monthsAhead = 3): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);

  for (let i = monthsAhead; i < monthsAhead + 18; i++) {
    const candidateDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1));
    const candidate = lastFridayAtNoonUtc(candidateDate.getUTCFullYear(), candidateDate.getUTCMonth() + 1);
    if (candidate > now + 45n * 24n * 60n * 60n) return candidate;
  }

  throw new Error("No valid future lending expiry found");
}

function lendingMarketKey(expiry: bigint, riskLevel = LENDING_RISK_LEVEL): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint64", "uint16"], [ETH, expiry, riskLevel]),
  );
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount)).wait();
}

async function assertLockedNotAboveTotal(vault: any, accounts: string[], tokenAddresses: string[] = []) {
  for (const account of accounts) {
    const ethTotal = await vault.ethBalances(account);
    const ethLocked = await vault.ethLocked(account);
    expect(ethLocked, `${account} ETH locked <= total`).to.be.lte(ethTotal);

    for (const token of tokenAddresses) {
      const total = await vault.erc20Balances(account, token);
      const locked = await vault.erc20Locked(account, token);
      expect(locked, `${account} token locked <= total`).to.be.lte(total);
    }
  }
}

async function assertErc20Custody(vault: any, token: any, accounts: string[]) {
  const tokenAddress = await token.getAddress();
  let internal = await vault.treasuryBalances(tokenAddress);
  for (const account of accounts) internal += await vault.erc20Balances(account, tokenAddress);
  expect(await token.balanceOf(await vault.getAddress()), "ERC20 custody under stress").to.equal(internal);
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
    await (await priceManager.connect(governance).approveOracleForContext(oracleAddress, OracleContext.FUTURE_SETTLEMENT)).wait();
  }

  await (await priceManager.syncOracleData(oracleAddress)).wait();
  expect(await priceManager.isOracleUsableForFutures(oracleAddress)).to.equal(true);
  return oracleAddress;
}

async function createFuturesMarket(contracts: any, governance: any, oracleAddress: string, label: string) {
  const marketKey = await contracts.futuresContract.computeMarketKey(oracleAddress);
  await (
    await contracts.futuresContract
      .connect(governance)
      .createMarket(label, oracleAddress, INITIAL_MARGIN_BPS, MAINTENANCE_MARGIN_BPS, MULTIPLIER, FUTURES_INITIAL_PRICE)
  ).wait();
  expect(await contracts.futuresContract.marketActive(marketKey)).to.equal(true);
  return marketKey;
}

async function placeTokenAsk(account: any, owner: any, orderBook: any, baseToken: string, quoteToken: string, price: bigint, amount: bigint) {
  const orderId = await orderBook.nextOrderId();
  await (
    await account
      .connect(owner)
      .placeOrderTokenSpot(await orderBook.getAddress(), ETH, baseToken, quoteToken, 1, price, amount, await freshOrderExpiry())
  ).wait();
  return orderId;
}

async function acceptTokenOrder(account: any, owner: any, orderBook: any, orderId: bigint, amount: bigint) {
  await (await account.connect(owner).acceptOrderTokenSpot(await orderBook.getAddress(), orderId, amount, ETH)).wait();
}

describe("Economic stress integration", function () {
  it("absorbs a volatile multi-price token spot sweep while preserving ERC20 custody", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const owners = [actors.alice, actors.bob, actors.carol, actors.dave, actors.lp1];
    const ownerAddresses = await Promise.all(owners.map((owner: any) => owner.getAddress()));
    await mintMockBalances(ethers, assets, ownerAddresses);

    const sellers = [] as Array<{ account: any; owner: any; address: string }>;
    for (const owner of [actors.alice, actors.bob, actors.carol, actors.dave]) {
      const account = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, owner);
      await depositToken(assets.tokenA, account, owner, 1_000n * ONE);
      await depositToken(assets.tokenB, account, owner, 100n * ONE);
      sellers.push({ account, owner, address: await account.getAddress() });
    }

    const taker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.lp1);
    await depositToken(assets.tokenA, taker, actors.lp1, 100n * ONE);
    await depositToken(assets.tokenB, taker, actors.lp1, 10_000n * ONE);
    const takerAddress = await taker.getAddress();

    const baseToken = await assets.tokenA.getAddress();
    const quoteToken = await assets.tokenB.getAddress();
    const allAccounts = [...sellers.map((seller) => seller.address), takerAddress];

    const orders: Array<{ id: bigint; amount: bigint }> = [];
    const prices = [ONE / 2n, ONE, 2n * ONE, 4n * ONE];
    for (const [index, seller] of sellers.entries()) {
      const amount = BigInt(index + 1) * 25n * ONE;
      const id = await placeTokenAsk(seller.account, seller.owner, contracts.tokenSpotOrderBook, baseToken, quoteToken, prices[index], amount);
      orders.push({ id, amount });
      await assertLockedNotAboveTotal(contracts.vault, allAccounts, [baseToken, quoteToken]);
    }

    for (const order of orders) {
      await acceptTokenOrder(taker, actors.lp1, contracts.tokenSpotOrderBook, order.id, order.amount);
      await assertLockedNotAboveTotal(contracts.vault, allAccounts, [baseToken, quoteToken]);
      await assertErc20Custody(contracts.vault, assets.tokenA, allAccounts);
      await assertErc20Custody(contracts.vault, assets.tokenB, allAccounts);
    }
  });

  it("measures a futures oracle gap shock without breaking margin or vault invariants", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const oracle = await deployMockOracle("STRESS-FUT/USD", FUTURES_INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(contracts.priceManager, timelockSigner, oracle);
    const marketKey = await createFuturesMarket(contracts, timelockSigner, oracleAddress, "STRESS-FUT");

    const shortAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const longAccount = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const shortAddress = await shortAccount.getAddress();
    const longAddress = await longAccount.getAddress();

    await depositEth(shortAccount, actors.alice, 3n * ONE);
    await depositEth(longAccount, actors.bob, 3n * ONE);

    await (
      await shortAccount
        .connect(actors.alice)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, FUTURES_INITIAL_PRICE, FUTURES_SIZE, 0, ETH)
    ).wait();
    await (
      await longAccount
        .connect(actors.bob)
        .placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, FUTURES_INITIAL_PRICE, FUTURES_SIZE, 0, ETH)
    ).wait();

    await (await oracle.setPrice(FUTURES_STRESS_PRICE)).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
    await (await contracts.settlementManager.connect(actors.deployer).settleAll(marketKey)).wait();

    const shortPosition = await contracts.futuresContract.getPosition(shortAddress, marketKey, false);
    const longPosition = await contracts.futuresContract.getPosition(longAddress, marketKey, true);
    const shortLocked = await contracts.vault.ethLocked(shortAddress);
    const longLocked = await contracts.vault.ethLocked(longAddress);

    expect(shortLocked, "short locked <= total after stress").to.be.lte(await contracts.vault.ethBalances(shortAddress));
    expect(longLocked, "long locked <= total after stress").to.be.lte(await contracts.vault.ethBalances(longAddress));
    expect(shortPosition.margin, "short margin cannot be negative").to.be.gte(0n);
    expect(longPosition.margin, "long margin remains non-negative").to.be.gte(0n);
    expect(await contracts.vault.settlementEthLocked(marketKey), "settlement bucket drained after settleAll").to.equal(0n);
  });

  it("runs a high-utilization lending fill with two lenders and one borrower while preserving debt and vault invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const lenderA = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const lenderB = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const borrower = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.carol);

    const lenderAAddress = await lenderA.getAddress();
    const lenderBAddress = await lenderB.getAddress();
    const borrowerAddress = await borrower.getAddress();

    await depositEth(lenderA, actors.alice, 60n * ONE);
    await depositEth(lenderB, actors.bob, 60n * ONE);
    await depositEth(borrower, actors.carol, 160n * ONE);

    const expiry = await nextLendingExpiry(3);
    const orderExpiry = await freshOrderExpiry(10);
    const principalA = 30n * ONE;
    const principalB = 30n * ONE;
    const borrowPrincipal = principalA + principalB;

    await (
      await lenderA
        .connect(actors.alice)
        .placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, expiry, LENDING_RISK_LEVEL, LENDING_RATE_BPS, principalA, orderExpiry)
    ).wait();
    await (
      await lenderB
        .connect(actors.bob)
        .placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, expiry, LENDING_RISK_LEVEL, LENDING_RATE_BPS, principalB, orderExpiry)
    ).wait();
    await (
      await borrower
        .connect(actors.carol)
        .placeBorrowOrder(await contracts.lendingOrderBook.getAddress(), ETH, expiry, LENDING_RISK_LEVEL, borrowPrincipal, LENDING_RATE_BPS, orderExpiry)
    ).wait();

    const key = lendingMarketKey(expiry);
    const debt = await contracts.lendingContract.getDebt(borrowerAddress, key);
    expect(debt.principal, "borrower principal after high-utilization fill").to.equal(borrowPrincipal);
    expect(await contracts.vault.ethBalances(borrowerAddress), "borrow proceeds remain account-held collateral").to.be.gte(220n * ONE);

    await assertLockedNotAboveTotal(contracts.vault, [lenderAAddress, lenderBAddress, borrowerAddress]);
  });
});
