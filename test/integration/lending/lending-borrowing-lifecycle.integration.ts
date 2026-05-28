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
const YEAR = 365n * 24n * 60n * 60n;
const BPS = 10_000n;

type ScenarioAccounts = {
  normalLender: any;
  lendingLender: any;
  borrower: any;
  normalLenderAddress: string;
  lendingLenderAddress: string;
  borrowerAddress: string;
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
  while (d.getUTCDay() !== 5) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  d.setUTCHours(12, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

async function nextLendingExpiry(monthsAhead = 2): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);

  for (let i = monthsAhead; i < monthsAhead + 18; i++) {
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

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function makeScenarioAccounts(contracts: any, actors: any): Promise<ScenarioAccounts> {
  const normalLender = await createNormalAccount(
    ethers,
    contracts.accountFactory,
    contracts.accountRegistry,
    actors.alice,
  );
  const lendingLender = await createLendingAccount(
    ethers,
    contracts.lendingAccountFactory,
    contracts.accountRegistry,
    actors.carol,
  );
  const borrower = await createLendingAccount(
    ethers,
    contracts.lendingAccountFactory,
    contracts.accountRegistry,
    actors.bob,
  );

  return {
    normalLender,
    lendingLender,
    borrower,
    normalLenderAddress: await normalLender.getAddress(),
    lendingLenderAddress: await lendingLender.getAddress(),
    borrowerAddress: await borrower.getAddress(),
  };
}

async function expectEthSplits(vault: any, account: string, total: bigint, locked: bigint) {
  expect(await vault.ethBalances(account), `${account} ETH total`).to.equal(total);
  expect(await vault.ethLocked(account), `${account} ETH locked`).to.equal(locked);
  expect(locked, `${account} locked <= total`).to.be.lte(total);

  const split = await vault.getEthBalances(account);
  expect(split.freeEth, `${account} free ETH`).to.equal(total - locked);
  expect(split.reservedOrderEth, `${account} locked ETH view`).to.equal(locked);
}

async function expectEthCustodyDelta(
  vault: any,
  vaultAddress: string,
  baselineVaultBalance: bigint,
  accounts: string[],
  settlementKeys: string[] = [],
) {
  let accounted = 0n;
  for (const account of accounts) {
    const total = await vault.ethBalances(account);
    const locked = await vault.ethLocked(account);
    expect(locked, `locked <= total for ${account}`).to.be.lte(total);
    accounted += total;
  }
  for (const key of settlementKeys) {
    accounted += await vault.settlementEthLocked(key);
  }
  expect(await ethers.provider.getBalance(vaultAddress), "ETH custody delta").to.equal(
    baselineVaultBalance + accounted,
  );
}

async function placeLendOrderFromNormal(
  account: any,
  owner: any,
  lendingOrderBook: string,
  expiry: bigint,
  principal: bigint,
  orderExpiry: bigint,
  rateBps: bigint = RATE_BPS,
) {
  await (
    await account
      .connect(owner)
      .placeLendOrder(
        lendingOrderBook,
        ETH,
        expiry,
        RISK_LEVEL,
        rateBps,
        principal,
        orderExpiry,
      )
  ).wait();
}

async function placeLendOrderFromLendingAccount(
  account: any,
  owner: any,
  lendingOrderBook: string,
  expiry: bigint,
  principal: bigint,
  orderExpiry: bigint,
  rateBps: bigint = RATE_BPS,
) {
  await (
    await account
      .connect(owner)
      .placeLendOrder(
        lendingOrderBook,
        ETH,
        expiry,
        RISK_LEVEL,
        rateBps,
        principal,
        orderExpiry,
      )
  ).wait();
}

async function placeBorrowOrder(
  account: any,
  owner: any,
  lendingOrderBook: string,
  expiry: bigint,
  principal: bigint,
  orderExpiry: bigint,
  rateBps: bigint = RATE_BPS,
) {
  await (
    await account
      .connect(owner)
      .placeBorrowOrder(
        lendingOrderBook,
        ETH,
        expiry,
        RISK_LEVEL,
        principal,
        rateBps,
        orderExpiry,
      )
  ).wait();
}

describe("Lending and borrowing lifecycle integration", function () {
  it("rejects malicious direct calls to lending contract and lending orderbook mutating surfaces", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attackerAddress = await actors.attacker.getAddress();
    const expiry = await nextLendingExpiry(2);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const key = marketKey(expiry);

    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        "LendingOrderBook.setLiquidationEngine",
        () =>
          contracts.lendingOrderBook
            .connect(actors.attacker)
            .setLiquidationEngine(attackerAddress, true),
      ],
      [
        "LendingOrderBook.setOrderLimits",
        () => contracts.lendingOrderBook.connect(actors.attacker).setOrderLimits(2, 2),
      ],
      [
        "LendingOrderBook.placeOrder lend from EOA",
        () =>
          contracts.lendingOrderBook
            .connect(actors.attacker)
            .placeOrder(ETH, expiry, RISK_LEVEL, 0, RATE_BPS, ONE, orderExpiry),
      ],
      [
        "LendingOrderBook.placeOrder borrow from EOA",
        () =>
          contracts.lendingOrderBook
            .connect(actors.attacker)
            .placeOrder(ETH, expiry, RISK_LEVEL, 1, RATE_BPS, ONE, orderExpiry),
      ],
      [
        "LendingOrderBook.placeRolloverBorrowOrder from EOA",
        () =>
          contracts.lendingOrderBook
            .connect(actors.attacker)
            .placeRolloverBorrowOrder(
              ETH,
              expiry,
              RISK_LEVEL,
              RATE_BPS,
              ONE,
              orderExpiry,
              key,
            ),
      ],
      [
        "LendingOrderBook.cancelOrder from EOA",
        () => contracts.lendingOrderBook.connect(actors.attacker).cancelOrder(1),
      ],
      [
        "LendingOrderBook.cancelAllOrdersForAccount from EOA",
        () =>
          contracts.lendingOrderBook
            .connect(actors.attacker)
            .cancelAllOrdersForAccount(attackerAddress),
      ],
      [
        "LendingContract.setRiskLevel",
        () => contracts.lendingContract.connect(actors.attacker).setRiskLevel(9, true, 1000, 2000),
      ],
      [
        "LendingContract.setOrderBook",
        () =>
          contracts.lendingContract
            .connect(actors.attacker)
            .setOrderBook(addresses.lendingOrderBook, true),
      ],
      [
        "LendingContract.setRiskModule",
        () => contracts.lendingContract.connect(actors.attacker).setRiskModule(attackerAddress),
      ],
      [
        "LendingContract.setRecoveryManager",
        () => contracts.lendingContract.connect(actors.attacker).setRecoveryManager(attackerAddress, true),
      ],
      [
        "LendingContract.setLossManager",
        () => contracts.lendingContract.connect(actors.attacker).setLossManager(attackerAddress, true),
      ],
      [
        "LendingContract.setMarketActive",
        () => contracts.lendingContract.connect(actors.attacker).setMarketActive(key, false),
      ],
      [
        "LendingContract.ensureMarket from EOA",
        () => contracts.lendingContract.connect(actors.attacker).ensureMarket(ETH, expiry, RISK_LEVEL),
      ],
      [
        "LendingContract.onBorrowOrderPlaced from EOA",
        () => contracts.lendingContract.connect(actors.attacker).onBorrowOrderPlaced(attackerAddress, key, ONE),
      ],
      [
        "LendingContract.executeMatch from EOA",
        () => contracts.lendingContract.connect(actors.attacker).executeMatch(attackerAddress, attackerAddress, key, ONE, RATE_BPS),
      ],
      [
        "LendingContract.repayDebtFromAccountVaultFor from EOA",
        () => contracts.lendingContract.connect(actors.attacker).repayDebtFromAccountVaultFor(attackerAddress, key, ONE),
      ],
      [
        "LendingContract.repayDebtFromVaultRecovery from EOA",
        () => contracts.lendingContract.connect(actors.attacker).repayDebtFromVaultRecovery(attackerAddress, key, ONE),
      ],
      [
        "LendingContract.recordBorrowerMarketLoss from EOA",
        () => contracts.lendingContract.connect(actors.attacker).recordBorrowerMarketLoss(attackerAddress, key, ONE),
      ],
      [
        "LendingContract.recordRecoveryFromVault from EOA",
        () => contracts.lendingContract.connect(actors.attacker).recordRecoveryFromVault(key, ONE),
      ],
      [
        "LendingContract.settleMarket from EOA",
        () => contracts.lendingContract.connect(actors.attacker).settleMarket(key),
      ],
    ];

    for (const [label, call] of calls) {
      await expectRevert(call(), label);
    }
  });

  it("lets both normal Accounts and LendingAccounts place and cancel lend orders with identical vault locking behavior", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeScenarioAccounts(contracts, actors);
    const expiry = await nextLendingExpiry(2);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const normalPrincipal = 2n * ONE;
    const lendingPrincipal = 3n * ONE;
    const vaultAddress = await contracts.vault.getAddress();
    const baselineVaultEth = await ethers.provider.getBalance(vaultAddress);

    await depositEth(s.normalLender, actors.alice, normalPrincipal);
    await depositEth(s.lendingLender, actors.carol, lendingPrincipal);

    const normalOrderId = await contracts.lendingOrderBook.nextOrderId();
    await placeLendOrderFromNormal(
      s.normalLender,
      actors.alice,
      addresses.lendingOrderBook,
      expiry,
      normalPrincipal,
      orderExpiry,
    );

    const lendingOrderId = await contracts.lendingOrderBook.nextOrderId();
    await placeLendOrderFromLendingAccount(
      s.lendingLender,
      actors.carol,
      addresses.lendingOrderBook,
      expiry,
      lendingPrincipal,
      orderExpiry,
    );

    await expectEthSplits(contracts.vault, s.normalLenderAddress, normalPrincipal, normalPrincipal);
    await expectEthSplits(contracts.vault, s.lendingLenderAddress, lendingPrincipal, lendingPrincipal);

    await (
      await s.normalLender.connect(actors.alice).cancelLendOrder(addresses.lendingOrderBook, normalOrderId)
    ).wait();
    await (
      await s.lendingLender.connect(actors.carol).cancelLendOrder(addresses.lendingOrderBook, lendingOrderId)
    ).wait();

    await expectEthSplits(contracts.vault, s.normalLenderAddress, normalPrincipal, 0n);
    await expectEthSplits(contracts.vault, s.lendingLenderAddress, lendingPrincipal, 0n);
    await expectEthCustodyDelta(contracts.vault, vaultAddress, baselineVaultEth, [
      s.normalLenderAddress,
      s.lendingLenderAddress,
    ]);
  });

  it("matches normal Account lender to LendingAccount borrower, supports repayment, settlement, and initial bond redemption", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeScenarioAccounts(contracts, actors);
    const expiry = await nextLendingExpiry(3);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const principal = ONE;
    const borrowerCollateral = 10n * ONE;
    const vaultAddress = await contracts.vault.getAddress();
    const baselineVaultEth = await ethers.provider.getBalance(vaultAddress);

    await depositEth(s.normalLender, actors.alice, principal);
    await depositEth(s.borrower, actors.bob, borrowerCollateral);

    const lendOrderId = await contracts.lendingOrderBook.nextOrderId();
    await placeLendOrderFromNormal(
      s.normalLender,
      actors.alice,
      addresses.lendingOrderBook,
      expiry,
      principal,
      orderExpiry,
    );

    const borrowOrderId = await contracts.lendingOrderBook.nextOrderId();
    const tx = await s.borrower
      .connect(actors.bob)
      .placeBorrowOrder(
        addresses.lendingOrderBook,
        ETH,
        expiry,
        RISK_LEVEL,
        principal,
        RATE_BPS,
        orderExpiry,
      );
    const receipt = await tx.wait();
    const matchTimestamp = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp);

    const key = marketKey(expiry);
    const face = expectedFaceValue(principal, RATE_BPS, expiry, matchTimestamp);

    expect(await contracts.lendingOrderBook.isOrderCancelled(lendOrderId), "resting maker order consumed").to.equal(true);
    const borrowTakerOrder = await contracts.lendingOrderBook.ordersById(borrowOrderId);
    expect(borrowTakerOrder.principal, "borrow taker principal consumed").to.equal(0n);
    expect(await contracts.lendingOrderBook.isOrderInBook(borrowOrderId), "borrow taker was never resting in book").to.equal(false);

    const lenderLots = await contracts.lendingContract.getUserBondLots(s.normalLenderAddress);
    expect(lenderLots.length, "normal Account bond lot count").to.equal(1);
    const bondIndex = lenderLots[0];
    const lot = await contracts.lendingContract.getBondLot(bondIndex);
    expect(lot.owner, "bond owner is normal Account").to.equal(s.normalLenderAddress);
    expect(lot.marketKey, "bond market key").to.equal(key);
    expect(lot.faceValue, "bond face value").to.equal(face);

    const debt = await contracts.lendingContract.getDebt(s.borrowerAddress, key);
    expect(debt.principal, "borrower debt principal").to.equal(principal);
    expect(debt.faceValue, "borrower debt face").to.equal(face);

    await expectEthSplits(contracts.vault, s.normalLenderAddress, 0n, 0n);
    await expectEthSplits(contracts.vault, s.borrowerAddress, borrowerCollateral + principal, 0n);
    await expectEthCustodyDelta(contracts.vault, vaultAddress, baselineVaultEth, [
      s.normalLenderAddress,
      s.borrowerAddress,
    ]);

    await (await s.borrower.connect(actors.bob).repayDebt(key, face)).wait();

    const debtAfterRepay = await contracts.lendingContract.getDebt(s.borrowerAddress, key);
    expect(debtAfterRepay.principal, "principal fully repaid").to.equal(0n);
    expect(debtAfterRepay.faceValue, "face fully repaid").to.equal(0n);
    expect(await contracts.vault.settlementEthLocked(key), "settlement liquidity from repayment").to.equal(face);

    await mineToTimestamp(expiry + 1n);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    await (await contracts.lendingContract.connect(timelockSigner).settleMarket(key)).wait();

    await (
      await s.normalLender
        .connect(actors.alice)
        .redeemInitialLendingBond(addresses.lendingContract, bondIndex)
    ).wait();

    const redeemedLot = await contracts.lendingContract.getBondLot(bondIndex);
    expect(redeemedLot.initialRedeemed, "normal Account bond redeemed").to.equal(true);
    expect(await contracts.vault.ethBalances(s.normalLenderAddress), "redeemed funds paid to Account vault balance").to.equal(face);
    expect(await contracts.vault.settlementEthLocked(key), "settlement fully paid out").to.equal(0n);
  });

  it("lets a LendingAccount also act as lender and redeem the same way as a normal Account", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeScenarioAccounts(contracts, actors);
    const expiry = await nextLendingExpiry(4);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const principal = ONE;
    const borrowerCollateral = 10n * ONE;

    await depositEth(s.lendingLender, actors.carol, principal);
    await depositEth(s.borrower, actors.bob, borrowerCollateral);

    await placeLendOrderFromLendingAccount(
      s.lendingLender,
      actors.carol,
      addresses.lendingOrderBook,
      expiry,
      principal,
      orderExpiry,
    );
    await placeBorrowOrder(
      s.borrower,
      actors.bob,
      addresses.lendingOrderBook,
      expiry,
      principal,
      orderExpiry,
    );

    const key = marketKey(expiry);
    const lenderLots = await contracts.lendingContract.getUserBondLots(s.lendingLenderAddress);
    expect(lenderLots.length, "lending Account bond lot count").to.equal(1);
    const bondIndex = lenderLots[0];
    const lot = await contracts.lendingContract.getBondLot(bondIndex);
    expect(lot.owner, "bond owner is LendingAccount").to.equal(s.lendingLenderAddress);

    await (await s.borrower.connect(actors.bob).repayDebt(key, lot.faceValue)).wait();
    await mineToTimestamp(expiry + 1n);
    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    await (await contracts.lendingContract.connect(timelockSigner).settleMarket(key)).wait();

    await (await s.lendingLender.connect(actors.carol).redeemInitialLendingBond(bondIndex)).wait();
    expect(await contracts.vault.ethBalances(s.lendingLenderAddress), "redeemed funds paid to LendingAccount").to.equal(lot.faceValue);
  });

  it("proves normal Accounts cannot borrow while LendingAccounts can place and cancel borrow orders", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const normalAccount = await createNormalAccount(
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
    const normalAddress = await normalAccount.getAddress();
    const borrowerAddress = await borrower.getAddress();
    const expiry = await nextLendingExpiry(5);
    const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const principal = ONE;

    expect((normalAccount as any).placeBorrowOrder, "normal Account borrow wrapper absent").to.equal(undefined);

    await expectRevert(
      contracts.lendingOrderBook
        .connect(actors.attacker)
        .placeOrder(ETH, expiry, RISK_LEVEL, 1, RATE_BPS, principal, orderExpiry),
      "EOA cannot borrow directly",
    );

    await depositEth(borrower, actors.bob, 10n * ONE);
    const borrowOrderId = await contracts.lendingOrderBook.nextOrderId();
    await placeBorrowOrder(
      borrower,
      actors.bob,
      addresses.lendingOrderBook,
      expiry,
      principal,
      orderExpiry,
    );

    expect(await contracts.lendingContract.getAccountPendingBorrow(borrowerAddress), "pending borrow recorded").to.equal(principal);

    await (await borrower.connect(actors.bob).cancelBorrowOrder(addresses.lendingOrderBook, borrowOrderId)).wait();
    expect(await contracts.lendingContract.getAccountPendingBorrow(borrowerAddress), "pending borrow released").to.equal(0n);

    expect(await contracts.lendingContract.getAccountPendingBorrow(normalAddress), "normal Account has no pending borrow").to.equal(0n);
  });
});
