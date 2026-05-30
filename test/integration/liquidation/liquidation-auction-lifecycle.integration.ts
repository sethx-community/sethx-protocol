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
import { expectRevert } from "../helpers/reverts.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;
const RISK_LEVEL = 1;
const RATE_BPS = 1_000n;
const STRESS_RATE_BPS = 6_000n;
const YEAR = 365n * 24n * 60n * 60n;
const BPS = 10_000n;
const RAY = 10n ** 27n;

const OracleContext = {
  COLLATERAL_EVAL: 3,
} as const;

type DebtScenario = {
  lender: any;
  borrower: any;
  lenderAddress: string;
  borrowerAddress: string;
  token: any;
  oracle: any;
  tokenAddress: string;
  oracleAddress: string;
  marketKey: string;
  expiry: bigint;
  principal: bigint;
  face: bigint;
  bondIndex: bigint;
};

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block unavailable");
  return BigInt(block.timestamp);
}

async function mineToTimestamp(timestamp: bigint) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
}

function marketKey(expiry: bigint, riskLevel = RISK_LEVEL): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint64", "uint16"],
      [ETH, expiry, riskLevel],
    ),
  );
}

function expectedFaceValue(
  principal: bigint,
  rateBps: bigint,
  expiry: bigint,
  matchTimestamp: bigint,
): bigint {
  const timeToExpiry = expiry - matchTimestamp;
  const interest = (principal * rateBps * timeToExpiry) / YEAR / BPS;
  return principal + interest;
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

async function nextLendingExpiry(monthsAhead = 2): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);

  for (let i = monthsAhead; i < monthsAhead + 24; i++) {
    const candidateDate = new Date(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1),
    );
    const candidate = lastFridayAtNoonUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
    );
    if (candidate > now + 30n * 24n * 60n * 60n) return candidate;
  }

  throw new Error("No valid future lending expiry found");
}

async function expectBlocked(label: string, promise: Promise<unknown>) {
  await expectRevert(promise, label);
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function registerCollateralOracle(
  contracts: any,
  governance: any,
  tokenAddress: string,
  oracle: any,
) {
  const oracleAddress = await oracle.getAddress();

  if (!(await contracts.priceManager.isApprovedOracle(oracleAddress))) {
    await (await contracts.priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  }

  if (!(await contracts.priceManager.isOracleApprovedFor(oracleAddress, OracleContext.COLLATERAL_EVAL))) {
    await (
      await contracts.priceManager
        .connect(governance)
        .approveOracleForContext(oracleAddress, OracleContext.COLLATERAL_EVAL)
    ).wait();
  }

  await (
    await contracts.priceManager
      .connect(governance)
      .setOracleMetadata(oracleAddress, tokenAddress, "LIQ-COLL", "Liquidation test collateral")
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .setTokenAllowedForContext(tokenAddress, OracleContext.COLLATERAL_EVAL, true)
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .registerOracleForTokenContext(tokenAddress, OracleContext.COLLATERAL_EVAL, oracleAddress)
  ).wait();
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();

  const [ok, registeredOracle] = await contracts.priceManager.getUsableOracleForTokenContext(
    tokenAddress,
    OracleContext.COLLATERAL_EVAL,
  );
  expect(ok, "collateral oracle usable").to.equal(true);
  expect(registeredOracle, "registered collateral oracle").to.equal(oracleAddress);

  return oracleAddress;
}

async function makeTokenCollateralDebtScenario(
  contracts: any,
  addresses: any,
  actors: any,
  monthsAhead = 10,
  principal = ONE,
  collateralTokens = 4n * ONE,
  rateBps = STRESS_RATE_BPS,
): Promise<DebtScenario> {
  const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

  const lender = await createNormalAccount(
    ethers,
    contracts.accountFactory,
    contracts.accountRegistry,
    actors.alice,
  );
  const borrower = await createLendingAccount(
    ethers,
    contracts.lendingAccountFactory,
    contracts.accountRegistry,
    actors.bob,
  );
  const lenderAddress = await lender.getAddress();
  const borrowerAddress = await borrower.getAddress();

  const token = await ethers.deployContract("MockERC20", ["Liquidation Collateral", "LCOL", 18]);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  // Price is denominated in ETH with 8 oracle decimals. 1 token = 1 ETH.
  const oracle = await ethers.deployContract("MockPriceOracle", ["LCOL/ETH", 8, 1n * 10n ** 8n]);
  await oracle.waitForDeployment();
  const oracleAddress = await registerCollateralOracle(contracts, timelockSigner, tokenAddress, oracle);

  await depositEth(lender, actors.alice, principal);
  await (await token.mint(await actors.bob.getAddress(), collateralTokens)).wait();
  await (await token.connect(actors.bob).approve(borrowerAddress, collateralTokens)).wait();
  await (await borrower.connect(actors.bob).depositToken(tokenAddress, collateralTokens, await borrower.getAddress(), await borrower.vault())).wait();

  const expiry = await nextLendingExpiry(monthsAhead);
  const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;

  await (
    await lender
      .connect(actors.alice)
      .placeLendOrder(addresses.lendingOrderBook, ETH, expiry, RISK_LEVEL, rateBps, principal, orderExpiry)
  ).wait();

  const tx = await borrower
    .connect(actors.bob)
    .placeBorrowOrder(addresses.lendingOrderBook, ETH, expiry, RISK_LEVEL, principal, rateBps, orderExpiry);
  const receipt = await tx.wait();
  const matchTimestamp = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp);

  const key = marketKey(expiry);
  const face = expectedFaceValue(principal, rateBps, expiry, matchTimestamp);
  const lenderLots = await contracts.lendingContract.getUserBondLots(lenderAddress);
  const bondIndex = lenderLots[lenderLots.length - 1];

  const debt = await contracts.lendingContract.getDebt(borrowerAddress, key);
  expect(debt.faceValue, "scenario debt face").to.equal(face);
  expect(await contracts.vault.ethBalances(borrowerAddress), "borrower free ETH is borrow proceeds only").to.equal(principal);
  expect(await contracts.vault.erc20Balances(borrowerAddress, tokenAddress), "ERC20 collateral deposited").to.equal(collateralTokens);

  return {
    lender,
    borrower,
    lenderAddress,
    borrowerAddress,
    token,
    oracle,
    tokenAddress,
    oracleAddress,
    marketKey: key,
    expiry,
    principal,
    face,
    bondIndex,
  };
}

async function makeLiquidatableScenario(contracts: any, addresses: any, actors: any): Promise<DebtScenario> {
  const s = await makeTokenCollateralDebtScenario(contracts, addresses, actors);
  await (await s.oracle.setPrice(1n)).wait();
  await (await contracts.priceManager.syncOracleData(s.oracleAddress)).wait();
  expect(await contracts.valuationModule.isLiquidatable(s.borrowerAddress, RISK_LEVEL), "price collapse makes account liquidatable").to.equal(true);
  return s;
}

function expectedPurchase(price: bigint, debt: bigint) {
  return {
    recovery: price >= debt ? debt : price,
    surplus: price >= debt ? price - debt : 0n,
    loss: price >= debt ? 0n : debt - price,
  };
}

async function activeAuction(contracts: any, account: string) {
  const a = await contracts.liquidationEngine.auctions(account);
  expect(a.active, "auction active").to.equal(true);
  return a;
}

describe("Liquidation and auction lifecycle integration", function () {
  it("rejects malicious direct calls to liquidation, recovery, loss, and auction-governance surfaces", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attacker = await actors.attacker.getAddress();

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["LiquidationEngine.setAuctionConfig", () => contracts.liquidationEngine.connect(actors.attacker).setAuctionConfig(1, 1, 1, 15_000, 10_000, 8_000)],
      ["LiquidationEngine.triggerLiquidation zero/fake", () => contracts.liquidationEngine.connect(actors.attacker).triggerLiquidation(attacker, ethers.ZeroHash, RISK_LEVEL)],
      ["LiquidationEngine.buyAuctionedAccount no auction", () => contracts.liquidationEngine.connect(actors.attacker).buyAuctionedAccount(attacker)],
      ["LiquidationEngine.markAuctionExpired no auction", () => contracts.liquidationEngine.connect(actors.attacker).markAuctionExpired(attacker)],
      ["LiquidationEngine.cancelAuction unauthorized", () => contracts.liquidationEngine.connect(actors.attacker).cancelAuction(attacker)],
      ["LendingContract.repayDebtFromVaultRecovery unauthorized", () => contracts.lendingContract.connect(actors.attacker).repayDebtFromVaultRecovery(attacker, ethers.ZeroHash, ONE)],
      ["LendingContract.recordBorrowerMarketLoss unauthorized", () => contracts.lendingContract.connect(actors.attacker).recordBorrowerMarketLoss(attacker, ethers.ZeroHash, ONE)],
      ["LendingContract.recordRecoveryFromVault unauthorized", () => contracts.lendingContract.connect(actors.attacker).recordRecoveryFromVault(ethers.ZeroHash, ONE)],
      ["LendingContract.recordMarketLoss disabled", () => contracts.lendingContract.connect(actors.attacker).recordMarketLoss(ethers.ZeroHash, ONE)],
    ];

    for (const [label, call] of calls) {
      await expectBlocked(label, call());
    }
  });

  it("triggers liquidation by undercollateralization, sweeps free ETH, cancels borrower orders, and starts auction", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeLiquidatableScenario(contracts, addresses, actors);
    const orderExpiry = (await latestTimestamp()) + 3n * 24n * 60n * 60n;

    // Open a borrower-side lend order so liquidation must cancel outstanding orders before sweeping free ETH.
    const orderId = await contracts.lendingOrderBook.nextOrderId();
    await (
      await s.borrower
        .connect(actors.bob)
        .placeLendOrder(addresses.lendingOrderBook, ETH, s.expiry, RISK_LEVEL, RATE_BPS, s.principal / 10n, orderExpiry)
    ).wait();
    expect(await contracts.lendingOrderBook.isOrderInBook(orderId), "borrower order resting before liquidation").to.equal(true);

    await (await contracts.liquidationEngine.connect(actors.dave).triggerLiquidation(s.borrowerAddress, s.marketKey, RISK_LEVEL)).wait();

    const auction = await activeAuction(contracts, s.borrowerAddress);
    const debtAfterSweep = await contracts.lendingContract.getDebt(s.borrowerAddress, s.marketKey);
    expect(await s.borrower.liquidationActive(), "borrower account frozen").to.equal(true);
    expect(await contracts.lendingOrderBook.isOrderCancelled(orderId), "borrower resting order cancelled during liquidation").to.equal(true);
    expect(await contracts.vault.ethBalances(s.borrowerAddress), "free ETH swept from liquidating account").to.equal(0n);
    expect(auction.freeEthRecoveredAtTrigger, "sweep recovered all free ETH/proceeds").to.equal(s.principal);
    expect(auction.debtSnapshot, "auction debt equals debt remaining after sweep").to.equal(debtAfterSweep.faceValue);
    expect(auction.debtSnapshot, "remaining debt is auctioned after ERC20 collateral crash").to.be.gt(0n);
    expect(await contracts.lendingContract.recoveredBeforeSettlement(s.marketKey), "swept proceeds recorded for lenders").to.equal(s.principal);
  });

  it("triggers liquidation by overdue debt even when the current account is not otherwise liquidatable", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeTokenCollateralDebtScenario(contracts, addresses, actors, 3, ONE, 6n * ONE, RATE_BPS);

    expect(await contracts.valuationModule.isLiquidatable(s.borrowerAddress, RISK_LEVEL), "healthy before maturity").to.equal(false);
    await expectBlocked(
      "early healthy liquidation blocked",
      contracts.liquidationEngine.connect(actors.attacker).triggerLiquidation(s.borrowerAddress, s.marketKey, RISK_LEVEL),
    );

    await mineToTimestamp(s.expiry + 1n);
    await (await contracts.liquidationEngine.connect(actors.attacker).triggerLiquidation(s.borrowerAddress, s.marketKey, RISK_LEVEL)).wait();
    const auction = await activeAuction(contracts, s.borrowerAddress);
    expect(auction.marketKey, "overdue auction market key").to.equal(s.marketKey);
    expect(await s.borrower.liquidationActive(), "overdue liquidation freezes account").to.equal(true);
  });

  it("lets a normal Account buy an auctioned LendingAccount and reconciles recovery, surplus, ownership transfer, and lender settlement", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeLiquidatableScenario(contracts, addresses, actors);
    const buyer = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    const buyerAddress = await buyer.getAddress();
    const buyerOwner = await actors.carol.getAddress();

    await (await contracts.liquidationEngine.connect(actors.dave).triggerLiquidation(s.borrowerAddress, s.marketKey, RISK_LEVEL)).wait();
    const auction = await activeAuction(contracts, s.borrowerAddress);
    const currentDebtBeforeBuy = (await contracts.lendingContract.getDebt(s.borrowerAddress, s.marketKey)).faceValue;
    const quotedPrice = await contracts.liquidationEngine.getCurrentAuctionPrice(s.borrowerAddress);

    await depositEth(buyer, actors.carol, quotedPrice + ONE);
    const buyerEthBefore = await contracts.vault.ethBalances(buyerAddress);
    await (await buyer.connect(actors.carol).buyAuctionedLendingAccount(addresses.liquidationEngine, s.borrowerAddress)).wait();
    const buyerEthAfter = await contracts.vault.ethBalances(buyerAddress);
    const paidPrice = buyerEthBefore - buyerEthAfter;
    const expected = expectedPurchase(paidPrice, currentDebtBeforeBuy);

    const afterAuction = await contracts.liquidationEngine.auctions(s.borrowerAddress);
    const debtAfter = await contracts.lendingContract.getDebt(s.borrowerAddress, s.marketKey);
    const totalsAfter = await contracts.lendingContract.getMarketTotals(s.marketKey);

    expect(afterAuction.active, "auction no longer active after purchase").to.equal(false);
    expect(afterAuction.sold, "auction marked sold").to.equal(true);
    expect(afterAuction.winner, "winner is buyer Account").to.equal(buyerAddress);
    expect(await s.borrower.owner(), "LendingAccount owner transferred to buyer owner").to.equal(buyerOwner);
    expect(await contracts.accountRegistry.ownerOfAccount(s.borrowerAddress), "registry owner transferred").to.equal(buyerOwner);
    expect(await s.borrower.liquidationActive(), "liquidation flag cleared after sale").to.equal(false);
    expect(debtAfter.faceValue, "auction purchase fully resolves borrower debt via recovery or loss").to.equal(0n);
    expect(totalsAfter.cumulativeLosses, "loss recorded exactly if auction price was below debt").to.equal(expected.loss);
    expect(paidPrice, "buyer paid no more than quoted auction price despite Dutch-auction block drift").to.be.lte(quotedPrice);
    expect(paidPrice, "buyer paid a positive auction price").to.be.gt(0n);
    expect(buyerEthAfter, "buyer vault balance decreased exactly by actual auction price").to.equal(buyerEthBefore - paidPrice);

    if (expected.surplus > 0n) {
      expect(await contracts.vault.ethBalances(s.borrowerAddress), "surplus routed to purchased account").to.equal(expected.surplus);
    }

    // Settlement after sale pays lenders according to recovery + loss accounting.
    await mineToTimestamp(s.expiry + 1n);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    await (await contracts.lendingContract.connect(timelockSigner).settleMarket(s.marketKey)).wait();
    const settlement = await contracts.lendingContract.getMarketSettlement(s.marketKey);
    const recovered = await contracts.lendingContract.recoveredBeforeSettlement(s.marketKey);
    const expectedRate = (recovered * RAY) / s.face;
    expect(settlement.initialRecoveryRateRay, "settlement recovery rate equals realized recovery / original face").to.equal(expectedRate);

    await (await s.lender.connect(actors.alice).redeemInitialLendingBond(addresses.lendingContract, s.bondIndex)).wait();
    const expectedRedeem = (s.face * expectedRate) / RAY;
    expect(await contracts.vault.ethBalances(s.lenderAddress), "lender redeem equals realized recovery share").to.equal(expectedRedeem);
  });

  it("lets an adequately collateralized restricted LendingAccount buy an auctioned account through the RiskModule-approved wrapper", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const auctioned = await makeLiquidatableScenario(contracts, addresses, actors);
    await (await contracts.liquidationEngine.connect(actors.dave).triggerLiquidation(auctioned.borrowerAddress, auctioned.marketKey, RISK_LEVEL)).wait();
    const auctionPrice = await contracts.liquidationEngine.getCurrentAuctionPrice(auctioned.borrowerAddress);

    const buyerLender = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.dave);
    const buyer = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.lp1);
    const buyerAddress = await buyer.getAddress();
    const buyerOwner = await actors.lp1.getAddress();
    const expiry = await nextLendingExpiry(11);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;

    // Give the buyer live debt so the LendingAccount wrapper must consult RiskModule.
    await depositEth(buyerLender, actors.dave, ONE / 10n);
    await depositEth(buyer, actors.lp1, auctionPrice + 5n * ONE);
    await (
      await buyerLender
        .connect(actors.dave)
        .placeLendOrder(addresses.lendingOrderBook, ETH, expiry, RISK_LEVEL, RATE_BPS, ONE / 10n, orderExpiry)
    ).wait();
    await (
      await buyer
        .connect(actors.lp1)
        .placeBorrowOrder(addresses.lendingOrderBook, ETH, expiry, RISK_LEVEL, ONE / 10n, RATE_BPS, orderExpiry)
    ).wait();
    expect(await buyer.isRestricted(), "buyer LendingAccount restricted before auction purchase").to.equal(true);
    expect(await contracts.valuationModule.canBuyAuctionedAccount(buyerAddress, RISK_LEVEL, addresses.liquidationEngine, auctioned.borrowerAddress), "risk module approves safe auction purchase").to.equal(true);

    await (await buyer.connect(actors.lp1).buyAuctionedLendingAccount(addresses.liquidationEngine, auctioned.borrowerAddress)).wait();

    expect(await auctioned.borrower.owner(), "auctioned account owner transferred to restricted buyer owner").to.equal(buyerOwner);
    expect(await contracts.accountRegistry.ownerOfAccount(auctioned.borrowerAddress), "registry owner transferred to restricted buyer owner").to.equal(buyerOwner);
    expect(await contracts.vault.ethLocked(buyerAddress), "buyer locked <= total after purchase").to.be.lte(
      await contracts.vault.ethBalances(buyerAddress),
    );
  });

  it("calculates LTV against collateral using pending borrow proceeds, so 100 ETH collateral plus a 100 ETH borrow request is 50% LTV", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const borrower = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.bob);
    const borrowerAddress = await borrower.getAddress();
    const expiry = await nextLendingExpiry(12);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const riskLevelWith50PctAllowance = 2;

    const levelOneTier = await contracts.valuationModule.riskTiers(RISK_LEVEL);
    expect(levelOneTier.maxLtvBps, "risk level 1 is intentionally below 50% LTV").to.be.lt(5_000n);

    await depositEth(borrower, actors.bob, 100n * ONE);

    expect(
      await contracts.valuationModule.canPlaceBorrowOrder(borrowerAddress, RISK_LEVEL, 100n * ONE),
      "100 existing collateral + 100 pending proceeds is 50% LTV, which risk level 1 currently rejects",
    ).to.equal(false);

    await (
      await borrower
        .connect(actors.bob)
        .placeBorrowOrder(
          addresses.lendingOrderBook,
          ETH,
          expiry,
          riskLevelWith50PctAllowance,
          100n * ONE,
          RATE_BPS,
          orderExpiry,
        )
    ).wait();

    const pendingDebt = await contracts.lendingContract.getAccountPendingBorrow(borrowerAddress);
    const pendingProceeds = await contracts.lendingContract.getAccountPendingBorrowProceeds(borrowerAddress);
    const ltvBps = await contracts.valuationModule.getLtvAgainstCollateral(borrowerAddress, riskLevelWith50PctAllowance);

    expect(pendingDebt, "pending borrow request counted as effective debt").to.equal(100n * ONE);
    expect(pendingProceeds, "pending borrow proceeds counted as collateral denominator").to.equal(100n * ONE);
    expect(ltvBps, "100 debt over 100 existing collateral + 100 pending proceeds = 50% LTV").to.equal(5_000n);
    expect(
      await contracts.valuationModule.canPlaceBorrowOrder(borrowerAddress, riskLevelWith50PctAllowance, 0),
      "pending 50% LTV remains acceptable under the current risk tier that permits 50%",
    ).to.equal(true);
  });

  it("handles auction cancellation and expiry without allowing stale or expired purchases", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const cancellable = await makeLiquidatableScenario(contracts, addresses, actors);
    await (await contracts.liquidationEngine.connect(actors.dave).triggerLiquidation(cancellable.borrowerAddress, cancellable.marketKey, RISK_LEVEL)).wait();
    await (await contracts.liquidationEngine.connect(timelockSigner).cancelAuction(cancellable.borrowerAddress)).wait();
    const cancelledAuction = await contracts.liquidationEngine.auctions(cancellable.borrowerAddress);
    expect(cancelledAuction.active, "cancelled auction inactive").to.equal(false);
    expect(await cancellable.borrower.liquidationActive(), "governor cancellation clears account liquidation flag").to.equal(false);
    await expectBlocked(
      "cancelled auction cannot be bought",
      contracts.liquidationEngine.connect(actors.attacker).buyAuctionedAccount(cancellable.borrowerAddress),
    );

    const expiring = await makeLiquidatableScenario(contracts, addresses, actors);
    await (await contracts.liquidationEngine.connect(actors.dave).triggerLiquidation(expiring.borrowerAddress, expiring.marketKey, RISK_LEVEL)).wait();
    const auction = await activeAuction(contracts, expiring.borrowerAddress);
    await mineToTimestamp(BigInt(auction.endTime) + 1n);

    const buyer = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    await depositEth(buyer, actors.carol, ONE);
    await expectBlocked(
      "expired auction purchase blocked",
      buyer.connect(actors.carol).buyAuctionedLendingAccount(addresses.liquidationEngine, expiring.borrowerAddress),
    );

    await (await contracts.liquidationEngine.connect(actors.attacker).markAuctionExpired(expiring.borrowerAddress)).wait();
    const expiredAuction = await contracts.liquidationEngine.auctions(expiring.borrowerAddress);
    expect(expiredAuction.active, "marked expired auction inactive").to.equal(false);
    expect(await expiring.borrower.liquidationActive(), "expired unsold account remains liquidating for governance follow-up").to.equal(true);
  });
});
