import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { createNormalAccount } from "../helpers/accounts.js";
import { deployMockAssets, mintMockBalances } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";

const { ethers } = await network.create();

const ONE = 10n ** 18n;
const ETH = ethers.ZeroAddress;
const FEE_CONTEXT = "Options Trade";

const OptionType = {
  Call: 0,
  Put: 1,
} as const;

const OrderIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;

type FeeOutput = {
  fixedAmount: bigint;
  fixedToken: string;
  percentageAmount: bigint;
  percentageToken: string;
};

type Balances = {
  token: bigint;
  eth: bigint;
  tokenLocked: bigint;
  ethLocked: bigint;
};

type CustodyBaseline = {
  tokenContract: bigint;
  ethContract: bigint;
  tokenTreasury: bigint;
  ethTreasury: bigint;
  accounts: Record<string, { token: bigint; eth: bigint }>;
};

function premiumFor(size: bigint, premiumPerUnit: bigint): bigint {
  return (size * premiumPerUnit) / ONE;
}

function strikeFor(size: bigint, strike: bigint): bigint {
  return (size * strike) / ONE;
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

function isFridayNoonUtc(ts: bigint): boolean {
  const day = ts / 86_400n;
  const weekday = (day + 4n) % 7n;
  return weekday === 5n && ts % 86_400n === 43_200n;
}

function nextFridayNoonAfter(afterTs: bigint): bigint {
  let candidate = ((afterTs / 86_400n) + 1n) * 86_400n + 43_200n;
  while (candidate <= afterTs || !isFridayNoonUtc(candidate)) {
    candidate += 86_400n;
  }
  return candidate;
}

async function mineToTimestamp(timestamp: bigint) {
  const latest = await latestTimestamp();
  if (latest >= timestamp) return;
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
}

async function getFee(
  feeManager: any,
  feeToken: string,
  premiumToken: string,
  premiumValue: bigint,
  account: string,
  isMaker: boolean,
): Promise<FeeOutput> {
  const fee = await feeManager.getFeeForAccount(
    feeToken,
    premiumToken,
    premiumValue,
    FEE_CONTEXT,
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
  if (ethers.getAddress(fee.fixedToken) === ethers.getAddress(ETH)) {
    total += fee.fixedAmount;
  }
  if (ethers.getAddress(fee.percentageToken) === ethers.getAddress(ETH)) {
    total += fee.percentageAmount;
  }
  return total;
}

async function balances(vault: any, account: string, token: string): Promise<Balances> {
  return {
    token: await vault.erc20Balances(account, token),
    eth: await vault.ethBalances(account),
    tokenLocked: await vault.erc20Locked(account, token),
    ethLocked: await vault.ethLocked(account),
  };
}

async function expectBalances(
  vault: any,
  account: string,
  token: string,
  expected: Balances,
) {
  const actual = await balances(vault, account, token);

  expect(actual.token, "token total").to.equal(expected.token);
  expect(actual.eth, "ETH total").to.equal(expected.eth);
  expect(actual.tokenLocked, "token locked").to.equal(expected.tokenLocked);
  expect(actual.ethLocked, "ETH locked").to.equal(expected.ethLocked);
  expect(actual.tokenLocked, "token locked <= total").to.be.lte(actual.token);
  expect(actual.ethLocked, "ETH locked <= total").to.be.lte(actual.eth);
}

async function depositTokenToAccount(
  token: any,
  account: any,
  owner: any,
  amount: bigint,
) {
  if (amount === 0n) return;
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount)).wait();
}

async function depositEthToAccount(account: any, owner: any, amount: bigint) {
  if (amount === 0n) return;
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function captureCustodyBaseline(
  vault: any,
  token: any,
  accounts: string[],
): Promise<CustodyBaseline> {
  const tokenAddress = await token.getAddress();
  const normalizedAccounts = accounts.map((a) => ethers.getAddress(a));
  const accountBalances: CustodyBaseline["accounts"] = {};

  for (const account of normalizedAccounts) {
    accountBalances[account] = {
      token: await vault.erc20Balances(account, tokenAddress),
      eth: await vault.ethBalances(account),
    };
  }

  return {
    tokenContract: await token.balanceOf(await vault.getAddress()),
    ethContract: await ethers.provider.getBalance(await vault.getAddress()),
    tokenTreasury: await vault.treasuryBalances(tokenAddress),
    ethTreasury: await vault.treasuryEthBalance(),
    accounts: accountBalances,
  };
}

async function expectCustodyDelta(
  vault: any,
  token: any,
  accounts: string[],
  baseline: CustodyBaseline,
) {
  const tokenAddress = await token.getAddress();
  const normalizedAccounts = accounts.map((a) => ethers.getAddress(a));

  let tokenInternalDelta =
    (await vault.treasuryBalances(tokenAddress)) - baseline.tokenTreasury;
  let ethInternalDelta = (await vault.treasuryEthBalance()) - baseline.ethTreasury;

  for (const account of normalizedAccounts) {
    const before = baseline.accounts[account] ?? { token: 0n, eth: 0n };
    tokenInternalDelta += (await vault.erc20Balances(account, tokenAddress)) - before.token;
    ethInternalDelta += (await vault.ethBalances(account)) - before.eth;
  }

  expect(
    (await token.balanceOf(await vault.getAddress())) - baseline.tokenContract,
    "token custody delta",
  ).to.equal(tokenInternalDelta);
  expect(
    (await ethers.provider.getBalance(await vault.getAddress())) - baseline.ethContract,
    "ETH custody delta",
  ).to.equal(ethInternalDelta);
}

async function buildCallScenario() {
  const { contracts } = await loadIntegratedDeployment(ethers);
  const actors = await loadActors(ethers);
  const assets = await deployMockAssets(ethers);

  await mintMockBalances(ethers, assets, [
    await actors.alice.getAddress(),
    await actors.bob.getAddress(),
  ]);

  const writer = await createNormalAccount(
    ethers,
    contracts.accountFactory,
    contracts.accountRegistry,
    actors.alice,
  );
  const holder = await createNormalAccount(
    ethers,
    contracts.accountFactory,
    contracts.accountRegistry,
    actors.bob,
  );

  const writerAddress = await writer.getAddress();
  const holderAddress = await holder.getAddress();
  const assetToken = await assets.tokenA.getAddress();

  const now = await latestTimestamp();
  const optionExpiry = nextFridayNoonAfter(now + 3n * 86_400n);
  const orderExpiry = now + 3_600n;
  const size = ethers.parseEther("10");
  const premiumPerUnit = ethers.parseEther("0.05");
  const strike = ethers.parseEther("2");
  const premium = premiumFor(size, premiumPerUnit);
  const strikePayment = strikeFor(size, strike);
  const takerFee = await getFee(
    contracts.feeManager,
    ETH,
    ETH,
    premium,
    holderAddress,
    false,
  );
  const takerFeeEth = ethFeeAmount(takerFee);
  const custodyBaseline = await captureCustodyBaseline(contracts.vault, assets.tokenA, [
    writerAddress,
    holderAddress,
  ]);

  await depositTokenToAccount(assets.tokenA, writer, actors.alice, size);
  await depositEthToAccount(holder, actors.bob, premium + strikePayment + takerFeeEth);

  return {
    contracts,
    actors,
    assets,
    writer,
    holder,
    writerAddress,
    holderAddress,
    assetToken,
    optionExpiry,
    orderExpiry,
    size,
    premiumPerUnit,
    strike,
    premium,
    strikePayment,
    takerFeeEth,
    custodyBaseline,
  };
}

describe("Options lifecycle integration", function () {
  it("rejects malicious direct calls to every OptionsOrderBook and OptionContract mutating function", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);
    const token = await assets.tokenA.getAddress();
    const now = await latestTimestamp();
    const expiry = nextFridayNoonAfter(now + 2n * 86_400n);

    await expectRevert(
      contracts.optionsOrderBook.connect(actors.attacker).setOrderLimits(1n, 1n),
    );
    await expectRevert(
      contracts.optionsOrderBook
        .connect(actors.attacker)
        .placeOrder(
          OptionType.Call,
          token,
          ETH,
          ONE,
          expiry,
          now + 60n,
          ETH,
          OrderIntent.WriteOption,
          ONE,
          ONE / 10n,
        ),
    );
    await expectRevert(
      contracts.optionsOrderBook.connect(actors.attacker).acceptOrder(1n, 1n, ETH),
    );
    await expectRevert(
      contracts.optionsOrderBook.connect(actors.attacker).cancelOrder(1n),
    );

    await expectRevert(contracts.optionContract.connect(actors.attacker).setStrikeDivider(50n));
    await expectRevert(
      contracts.optionContract.connect(actors.attacker).setDefaultExerciseWindow(86_400n),
    );
    await expectRevert(
      contracts.optionContract
        .connect(actors.attacker)
        .registerNewOption(
          OptionType.Call,
          token,
          ETH,
          ONE,
          expiry,
          await actors.alice.getAddress(),
          await actors.bob.getAddress(),
          ONE,
        ),
    );
    await expectRevert(
      contracts.optionContract
        .connect(actors.attacker)
        .transferPosition(ethers.ZeroHash, await actors.alice.getAddress(), await actors.bob.getAddress(), ONE, false),
    );
    await expectRevert(
      contracts.optionContract
        .connect(actors.attacker)
        .reservePosition(ethers.ZeroHash, await actors.alice.getAddress(), ONE, false),
    );
    await expectRevert(
      contracts.optionContract
        .connect(actors.attacker)
        .releasePositionReservation(ethers.ZeroHash, await actors.alice.getAddress(), ONE, false),
    );
    await expectRevert(
      contracts.optionContract.connect(actors.attacker).exercise(ethers.ZeroHash, ONE),
    );
    await expectRevert(
      contracts.optionContract.connect(actors.attacker).reclaimExpired(ethers.ZeroHash),
    );
    await expectRevert(
      contracts.optionContract.connect(actors.attacker).clearExpiredHolder(ethers.ZeroHash),
    );
  });

  it("writes, sells, and exercises a regular call option through Accounts with exact custody reconciliation", async function () {
    const s = await buildCallScenario();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: 0n,
      tokenLocked: 0n,
      ethLocked: 0n,
    });
    await expectBalances(s.contracts.vault, s.holderAddress, s.assetToken, {
      token: 0n,
      eth: s.premium + s.strikePayment + s.takerFeeEth,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    const orderId = await s.contracts.optionsOrderBook.nextOrderId();

    await (
      await s.writer.connect(s.actors.alice).placeOrderOption(
        await s.contracts.optionsOrderBook.getAddress(),
        OptionType.Call,
        s.assetToken,
        ETH,
        s.strike,
        s.optionExpiry,
        s.orderExpiry,
        ETH,
        OrderIntent.WriteOption,
        s.size,
        s.premiumPerUnit,
      )
    ).wait();

    const normalizedStrike = await s.contracts.optionContract.normalizeStrike(s.strike);
    const marketKey = await s.contracts.optionContract.computeMarketKey(
      OptionType.Call,
      s.assetToken,
      ETH,
      normalizedStrike,
      s.optionExpiry,
    );

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: 0n,
      tokenLocked: s.size,
      ethLocked: 0n,
    });

    await (
      await s.holder
        .connect(s.actors.bob)
        .acceptOrderOption(await s.contracts.optionsOrderBook.getAddress(), orderId, s.size, ETH)
    ).wait();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: s.premium,
      tokenLocked: s.size,
      ethLocked: 0n,
    });
    await expectBalances(s.contracts.vault, s.holderAddress, s.assetToken, {
      token: 0n,
      eth: s.strikePayment,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    const [writerSize, holderSize, holderExercised] =
      await s.contracts.optionContract.getUserPosition(marketKey, s.holderAddress);
    expect(writerSize, "holder must not have writer position").to.equal(0n);
    expect(holderSize, "holder option position").to.equal(s.size);
    expect(holderExercised, "holder exercised before expiry").to.equal(0n);

    await expectRevert(
      s.holder
        .connect(s.actors.bob)
        .exerciseOption(await s.contracts.optionContract.getAddress(), marketKey, s.size),
    );

    await mineToTimestamp(s.optionExpiry + 1n);

    await (
      await s.holder
        .connect(s.actors.bob)
        .exerciseOption(await s.contracts.optionContract.getAddress(), marketKey, s.size)
    ).wait();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: 0n,
      eth: s.premium + s.strikePayment,
      tokenLocked: 0n,
      ethLocked: 0n,
    });
    await expectBalances(s.contracts.vault, s.holderAddress, s.assetToken, {
      token: s.size,
      eth: 0n,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    await expectCustodyDelta(s.contracts.vault, s.assets.tokenA, [
      s.writerAddress,
      s.holderAddress,
    ], s.custodyBaseline);
    expect(await s.contracts.optionContract.marketOpenInterest(marketKey)).to.equal(0n);
  });

  it("writes, sells, and exercises a regular put option through Accounts with exact custody reconciliation", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
    ]);

    const writer = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );
    const holder = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const writerAddress = await writer.getAddress();
    const holderAddress = await holder.getAddress();
    const assetToken = await assets.tokenA.getAddress();
    const now = await latestTimestamp();
    const optionExpiry = nextFridayNoonAfter(now + 3n * 86_400n);
    const orderExpiry = now + 3_600n;
    const size = ethers.parseEther("8");
    const strike = ethers.parseEther("3");
    const premiumPerUnit = ethers.parseEther("0.04");
    const premium = premiumFor(size, premiumPerUnit);
    const strikeCollateral = strikeFor(size, strike);
    const takerFee = await getFee(contracts.feeManager, ETH, ETH, premium, holderAddress, false);
    const takerFeeEth = ethFeeAmount(takerFee);
    const custodyBaseline = await captureCustodyBaseline(contracts.vault, assets.tokenA, [
      writerAddress,
      holderAddress,
    ]);

    await depositEthToAccount(writer, actors.alice, strikeCollateral);
    await depositTokenToAccount(assets.tokenA, holder, actors.bob, size);
    await depositEthToAccount(holder, actors.bob, premium + takerFeeEth);

    const orderId = await contracts.optionsOrderBook.nextOrderId();

    await (
      await writer.connect(actors.alice).placeOrderOption(
        await contracts.optionsOrderBook.getAddress(),
        OptionType.Put,
        assetToken,
        ETH,
        strike,
        optionExpiry,
        orderExpiry,
        ETH,
        OrderIntent.WriteOption,
        size,
        premiumPerUnit,
      )
    ).wait();

    const normalizedStrike = await contracts.optionContract.normalizeStrike(strike);
    const marketKey = await contracts.optionContract.computeMarketKey(
      OptionType.Put,
      assetToken,
      ETH,
      normalizedStrike,
      optionExpiry,
    );

    await expectBalances(contracts.vault, writerAddress, assetToken, {
      token: 0n,
      eth: strikeCollateral,
      tokenLocked: 0n,
      ethLocked: strikeCollateral,
    });

    await (
      await holder
        .connect(actors.bob)
        .acceptOrderOption(await contracts.optionsOrderBook.getAddress(), orderId, size, ETH)
    ).wait();

    await expectBalances(contracts.vault, writerAddress, assetToken, {
      token: 0n,
      eth: strikeCollateral + premium,
      tokenLocked: 0n,
      ethLocked: strikeCollateral,
    });
    await expectBalances(contracts.vault, holderAddress, assetToken, {
      token: size,
      eth: 0n,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    await mineToTimestamp(optionExpiry + 1n);

    await (
      await holder
        .connect(actors.bob)
        .exerciseOption(await contracts.optionContract.getAddress(), marketKey, size)
    ).wait();

    await expectBalances(contracts.vault, writerAddress, assetToken, {
      token: size,
      eth: premium,
      tokenLocked: 0n,
      ethLocked: 0n,
    });
    await expectBalances(contracts.vault, holderAddress, assetToken, {
      token: 0n,
      eth: strikeCollateral,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    await expectCustodyDelta(contracts.vault, assets.tokenA, [
      writerAddress,
      holderAddress,
    ], custodyBaseline);
    expect(await contracts.optionContract.marketOpenInterest(marketKey)).to.equal(0n);
  });

  it("reclaims unexercised writer collateral and clears expired holder positions after the exercise window", async function () {
    const s = await buildCallScenario();
    const orderId = await s.contracts.optionsOrderBook.nextOrderId();

    await (
      await s.writer.connect(s.actors.alice).placeOrderOption(
        await s.contracts.optionsOrderBook.getAddress(),
        OptionType.Call,
        s.assetToken,
        ETH,
        s.strike,
        s.optionExpiry,
        s.orderExpiry,
        ETH,
        OrderIntent.WriteOption,
        s.size,
        s.premiumPerUnit,
      )
    ).wait();

    await (
      await s.holder
        .connect(s.actors.bob)
        .acceptOrderOption(await s.contracts.optionsOrderBook.getAddress(), orderId, s.size, ETH)
    ).wait();

    const normalizedStrike = await s.contracts.optionContract.normalizeStrike(s.strike);
    const marketKey = await s.contracts.optionContract.computeMarketKey(
      OptionType.Call,
      s.assetToken,
      ETH,
      normalizedStrike,
      s.optionExpiry,
    );
    const market = await s.contracts.optionContract.getMarket(marketKey);
    const exerciseWindow = market.exerciseWindow;

    await mineToTimestamp(s.optionExpiry + exerciseWindow + 1n);

    await expectRevert(
      s.holder
        .connect(s.actors.bob)
        .exerciseOption(await s.contracts.optionContract.getAddress(), marketKey, s.size),
    );

    await (
      await s.writer
        .connect(s.actors.alice)
        .reclaimExpiredOption(await s.contracts.optionContract.getAddress(), marketKey)
    ).wait();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: s.premium,
      tokenLocked: 0n,
      ethLocked: 0n,
    });

    await (
      await s.holder
        .connect(s.actors.bob)
        .clearExpiredOptionHolder(await s.contracts.optionContract.getAddress(), marketKey)
    ).wait();

    await expectRevert(
      s.writer
        .connect(s.actors.alice)
        .reclaimExpiredOption(await s.contracts.optionContract.getAddress(), marketKey),
    );
    await expectRevert(
      s.holder
        .connect(s.actors.bob)
        .clearExpiredOptionHolder(await s.contracts.optionContract.getAddress(), marketKey),
    );

    await expectCustodyDelta(s.contracts.vault, s.assets.tokenA, [
      s.writerAddress,
      s.holderAddress,
    ], s.custodyBaseline);
    expect(await s.contracts.optionContract.marketOpenInterest(marketKey)).to.equal(0n);
  });

  it("cancels an unfilled write order and releases only the writer collateral", async function () {
    const s = await buildCallScenario();
    const orderId = await s.contracts.optionsOrderBook.nextOrderId();

    await (
      await s.writer.connect(s.actors.alice).placeOrderOption(
        await s.contracts.optionsOrderBook.getAddress(),
        OptionType.Call,
        s.assetToken,
        ETH,
        s.strike,
        s.optionExpiry,
        s.orderExpiry,
        ETH,
        OrderIntent.WriteOption,
        s.size,
        s.premiumPerUnit,
      )
    ).wait();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: 0n,
      tokenLocked: s.size,
      ethLocked: 0n,
    });

    await (
      await s.writer
        .connect(s.actors.alice)
        .cancelOrderOption(await s.contracts.optionsOrderBook.getAddress(), orderId)
    ).wait();

    await expectBalances(s.contracts.vault, s.writerAddress, s.assetToken, {
      token: s.size,
      eth: 0n,
      tokenLocked: 0n,
      ethLocked: 0n,
    });
    await expectRevert(
      s.writer
        .connect(s.actors.alice)
        .cancelOrderOption(await s.contracts.optionsOrderBook.getAddress(), orderId),
    );
  });
});
