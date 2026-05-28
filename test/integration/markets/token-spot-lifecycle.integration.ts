import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { createNormalAccount } from "../helpers/accounts.js";
import { deployMockAssets, mintMockBalances } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ONE = 10n ** 18n;
const FEE_CONTEXT = "ERC20 Spot Trade";
const ETH = ethers.ZeroAddress;

type FeeOutput = {
  fixedAmount: bigint;
  fixedToken: string;
  percentageAmount: bigint;
  percentageToken: string;
};

type TokenBalances = {
  base: bigint;
  quote: bigint;
  eth: bigint;
  baseLocked: bigint;
  quoteLocked: bigint;
  ethLocked: bigint;
};

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  return (baseAmount * price) / ONE;
}

async function getFee(
  feeManager: any,
  feeToken: string,
  assetToken: string,
  assetValue: bigint,
  account: string,
  isMaker: boolean,
): Promise<FeeOutput> {
  const fee = await feeManager.getFeeForAccount(
    feeToken,
    assetToken,
    assetValue,
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

function addIfToken(current: bigint, fee: FeeOutput, token: string): bigint {
  let next = current;
  if (ethers.getAddress(fee.fixedToken) === ethers.getAddress(token)) {
    next += fee.fixedAmount;
  }
  if (ethers.getAddress(fee.percentageToken) === ethers.getAddress(token)) {
    next += fee.percentageAmount;
  }
  return next;
}

function chargedPercentageProRata(
  totalPercentageFee: bigint,
  filled: bigint,
  initial: bigint,
): bigint {
  if (totalPercentageFee === 0n || initial === 0n) return 0n;
  if (filled >= initial) return totalPercentageFee;
  return (totalPercentageFee * filled) / initial;
}

async function accountBalances(
  vault: any,
  account: string,
  baseToken: string,
  quoteToken: string,
): Promise<TokenBalances> {
  return {
    base: await vault.erc20Balances(account, baseToken),
    quote: await vault.erc20Balances(account, quoteToken),
    eth: await vault.ethBalances(account),
    baseLocked: await vault.erc20Locked(account, baseToken),
    quoteLocked: await vault.erc20Locked(account, quoteToken),
    ethLocked: await vault.ethLocked(account),
  };
}

async function expectAccountBalances(
  vault: any,
  account: string,
  baseToken: string,
  quoteToken: string,
  expected: TokenBalances,
) {
  const actual = await accountBalances(vault, account, baseToken, quoteToken);

  expect(actual.base, "base total").to.equal(expected.base);
  expect(actual.quote, "quote total").to.equal(expected.quote);
  expect(actual.eth, "ETH total").to.equal(expected.eth);
  expect(actual.baseLocked, "base locked").to.equal(expected.baseLocked);
  expect(actual.quoteLocked, "quote locked").to.equal(expected.quoteLocked);
  expect(actual.ethLocked, "ETH locked").to.equal(expected.ethLocked);

  expect(actual.baseLocked, "base locked <= total").to.be.lte(actual.base);
  expect(actual.quoteLocked, "quote locked <= total").to.be.lte(actual.quote);
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

async function prepareSpotAccount(
  account: any,
  owner: any,
  baseToken: any,
  quoteToken: any,
  baseAmount: bigint,
  quoteAmount: bigint,
  ethAmount: bigint,
) {
  await depositTokenToAccount(baseToken, account, owner, baseAmount);
  await depositTokenToAccount(quoteToken, account, owner, quoteAmount);
  await depositEthToAccount(account, owner, ethAmount);
}

async function expectTokenCustodyForPair(
  vault: any,
  baseToken: any,
  quoteToken: any,
  accounts: string[],
) {
  const baseAddress = await baseToken.getAddress();
  const quoteAddress = await quoteToken.getAddress();

  let baseInternal = await vault.treasuryBalances(baseAddress);
  let quoteInternal = await vault.treasuryBalances(quoteAddress);

  for (const account of accounts) {
    baseInternal += await vault.erc20Balances(account, baseAddress);
    quoteInternal += await vault.erc20Balances(account, quoteAddress);
  }

  expect(await baseToken.balanceOf(await vault.getAddress()), "base custody").to.equal(
    baseInternal,
  );
  expect(await quoteToken.balanceOf(await vault.getAddress()), "quote custody").to.equal(
    quoteInternal,
  );
}

describe("Token spot orderbook lifecycle integration", function () {
  it("rejects malicious direct calls to every TokenSpotOrderBook mutating function", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attackerAddress = await actors.attacker.getAddress();

    const assets = await deployMockAssets(ethers);
    const baseToken = await assets.tokenA.getAddress();
    const quoteToken = await assets.tokenB.getAddress();

    await expectRevert(
      contracts.tokenSpotOrderBook.connect(actors.attacker).setOrderLimits(1n, 1n),
    );

    await expectRevert(
      contracts.tokenSpotOrderBook
        .connect(actors.attacker)
        .placeOrder(ETH, baseToken, quoteToken, 1, ONE, ONE, 0),
    );

    await expectRevert(
      contracts.tokenSpotOrderBook.connect(actors.attacker).acceptOrder(1n, 1n, ETH),
    );

    await expectRevert(
      contracts.tokenSpotOrderBook.connect(actors.attacker).cancelOrder(1n),
    );

    await expectRevert(
      contracts.tokenSpotOrderBook
        .connect(actors.attacker)
        .sweepExpiredOrders(baseToken, quoteToken, 1, 10n),
    );

    expect(attackerAddress).to.not.equal(ethers.ZeroAddress);
  });

  it("executes a full ERC20 spot fill through Accounts with exact custody, locks, fees, and order cleanup", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
    ]);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );
    const bobAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const aliceAccountAddress = await aliceAccount.getAddress();
    const bobAccountAddress = await bobAccount.getAddress();
    const baseToken = await assets.tokenA.getAddress();
    const quoteToken = await assets.tokenB.getAddress();

    expect(await contracts.feeManager.isAcceptedFeeToken(ETH)).to.equal(true);

    const baseAmount = ethers.parseEther("10");
    const price = ethers.parseEther("2");
    const quoteAmount = quoteFor(baseAmount, price);

    const makerFee = await getFee(
      contracts.feeManager,
      ETH,
      baseToken,
      baseAmount,
      aliceAccountAddress,
      true,
    );
    const takerFee = await getFee(
      contracts.feeManager,
      ETH,
      quoteToken,
      quoteAmount,
      bobAccountAddress,
      false,
    );

    const aliceBaseDeposit = addIfToken(baseAmount, makerFee, baseToken);
    const aliceQuoteDeposit = addIfToken(0n, makerFee, quoteToken);
    const aliceEthDeposit = addIfToken(0n, makerFee, ETH);

    const bobBaseDeposit = addIfToken(0n, takerFee, baseToken);
    const bobQuoteDeposit = addIfToken(quoteAmount, takerFee, quoteToken);
    const bobEthDeposit = addIfToken(0n, takerFee, ETH);

    const treasuryEthBefore = await contracts.vault.treasuryEthBalance();
    const treasuryBaseBefore = await contracts.vault.treasuryBalances(baseToken);
    const treasuryQuoteBefore = await contracts.vault.treasuryBalances(quoteToken);

    await prepareSpotAccount(
      aliceAccount,
      actors.alice,
      assets.tokenA,
      assets.tokenB,
      aliceBaseDeposit,
      aliceQuoteDeposit,
      aliceEthDeposit,
    );
    await prepareSpotAccount(
      bobAccount,
      actors.bob,
      assets.tokenA,
      assets.tokenB,
      bobBaseDeposit,
      bobQuoteDeposit,
      bobEthDeposit,
    );

    const nextOrderIdBefore = await contracts.tokenSpotOrderBook.nextOrderId();

    await (
      await aliceAccount
        .connect(actors.alice)
        .placeOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          ETH,
          baseToken,
          quoteToken,
          1,
          price,
          baseAmount,
          0,
        )
    ).wait();

    const makerOrderId = nextOrderIdBefore;
    const makerOrder = await contracts.tokenSpotOrderBook.getOrder(makerOrderId);

    expect(makerOrder.user).to.equal(aliceAccountAddress);
    expect(makerOrder.amount).to.equal(baseAmount);
    expect(makerOrder.fixedFeeAmount).to.equal(makerFee.fixedAmount);
    expect(makerOrder.fixedFeeToken).to.equal(makerFee.fixedToken);
    expect(makerOrder.percentageFeeAmount).to.equal(makerFee.percentageAmount);
    expect(makerOrder.percentageFeeToken).to.equal(makerFee.percentageToken);

    await expectAccountBalances(contracts.vault, aliceAccountAddress, baseToken, quoteToken, {
      base: aliceBaseDeposit,
      quote: aliceQuoteDeposit,
      eth: aliceEthDeposit,
      baseLocked: baseAmount + (makerFee.percentageToken === baseToken ? makerFee.percentageAmount : 0n),
      quoteLocked: makerFee.percentageToken === quoteToken ? makerFee.percentageAmount : 0n,
      ethLocked: makerFee.fixedToken === ETH ? makerFee.fixedAmount : 0n,
    });

    await (
      await bobAccount
        .connect(actors.bob)
        .acceptOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          makerOrderId,
          baseAmount,
          ETH,
        )
    ).wait();

    const removed = await contracts.tokenSpotOrderBook.getOrder(makerOrderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);
    expect(
      await contracts.tokenSpotOrderBook.getActiveBookOrderCount(baseToken, quoteToken),
    ).to.equal(0n);

    await expectAccountBalances(contracts.vault, aliceAccountAddress, baseToken, quoteToken, {
      base: 0n,
      quote: quoteAmount + aliceQuoteDeposit,
      eth: 0n,
      baseLocked: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await expectAccountBalances(contracts.vault, bobAccountAddress, baseToken, quoteToken, {
      base: baseAmount + bobBaseDeposit,
      quote: 0n,
      eth: 0n,
      baseLocked: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    expect(await contracts.vault.treasuryEthBalance()).to.equal(
      treasuryEthBefore +
        (makerFee.fixedToken === ETH ? makerFee.fixedAmount : 0n) +
        (takerFee.fixedToken === ETH ? takerFee.fixedAmount : 0n),
    );
    expect(await contracts.vault.treasuryBalances(baseToken)).to.equal(
      treasuryBaseBefore +
        (makerFee.fixedToken === baseToken ? makerFee.fixedAmount : 0n) +
        (makerFee.percentageToken === baseToken ? makerFee.percentageAmount : 0n) +
        (takerFee.fixedToken === baseToken ? takerFee.fixedAmount : 0n) +
        (takerFee.percentageToken === baseToken ? takerFee.percentageAmount : 0n),
    );
    expect(await contracts.vault.treasuryBalances(quoteToken)).to.equal(
      treasuryQuoteBefore +
        (makerFee.fixedToken === quoteToken ? makerFee.fixedAmount : 0n) +
        (makerFee.percentageToken === quoteToken ? makerFee.percentageAmount : 0n) +
        (takerFee.fixedToken === quoteToken ? takerFee.fixedAmount : 0n) +
        (takerFee.percentageToken === quoteToken ? takerFee.percentageAmount : 0n),
    );

    await expectTokenCustodyForPair(contracts.vault, assets.tokenA, assets.tokenB, [
      aliceAccountAddress,
      bobAccountAddress,
    ]);
  });

  it("partially fills, charges pro-rata fees, cancels the remainder, and releases only remaining locks", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
    ]);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );
    const bobAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const aliceAccountAddress = await aliceAccount.getAddress();
    const bobAccountAddress = await bobAccount.getAddress();
    const baseToken = await assets.tokenA.getAddress();
    const quoteToken = await assets.tokenB.getAddress();

    const makerBaseAmount = ethers.parseEther("10");
    const fillBaseAmount = ethers.parseEther("4");
    const price = ethers.parseEther("2");
    const fillQuoteAmount = quoteFor(fillBaseAmount, price);

    const makerFee = await getFee(
      contracts.feeManager,
      ETH,
      baseToken,
      makerBaseAmount,
      aliceAccountAddress,
      true,
    );
    const takerFee = await getFee(
      contracts.feeManager,
      ETH,
      quoteToken,
      fillQuoteAmount,
      bobAccountAddress,
      false,
    );

    const aliceBaseDeposit = addIfToken(makerBaseAmount, makerFee, baseToken);
    const aliceQuoteDeposit = addIfToken(0n, makerFee, quoteToken);
    const aliceEthDeposit = addIfToken(0n, makerFee, ETH);
    const bobBaseDeposit = addIfToken(0n, takerFee, baseToken);
    const bobQuoteDeposit = addIfToken(fillQuoteAmount, takerFee, quoteToken);
    const bobEthDeposit = addIfToken(0n, takerFee, ETH);

    await prepareSpotAccount(
      aliceAccount,
      actors.alice,
      assets.tokenA,
      assets.tokenB,
      aliceBaseDeposit,
      aliceQuoteDeposit,
      aliceEthDeposit,
    );
    await prepareSpotAccount(
      bobAccount,
      actors.bob,
      assets.tokenA,
      assets.tokenB,
      bobBaseDeposit,
      bobQuoteDeposit,
      bobEthDeposit,
    );

    const nextOrderIdBefore = await contracts.tokenSpotOrderBook.nextOrderId();
    await (
      await aliceAccount
        .connect(actors.alice)
        .placeOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          ETH,
          baseToken,
          quoteToken,
          1,
          price,
          makerBaseAmount,
          0,
        )
    ).wait();
    const makerOrderId = nextOrderIdBefore;

    await (
      await bobAccount
        .connect(actors.bob)
        .acceptOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          makerOrderId,
          fillBaseAmount,
          ETH,
        )
    ).wait();

    const makerPctCharged = chargedPercentageProRata(
      makerFee.percentageAmount,
      fillBaseAmount,
      makerBaseAmount,
    );
    const makerPctUncharged = makerFee.percentageAmount - makerPctCharged;
    const remainingBase = makerBaseAmount - fillBaseAmount;

    const partiallyFilledOrder = await contracts.tokenSpotOrderBook.getOrder(makerOrderId);
    expect(partiallyFilledOrder.user).to.equal(aliceAccountAddress);
    expect(partiallyFilledOrder.amount).to.equal(remainingBase);
    expect(partiallyFilledOrder.percentageFeeCharged).to.equal(makerPctCharged);
    expect(partiallyFilledOrder.fixedFeeCharged).to.equal(true);

    await expectAccountBalances(contracts.vault, aliceAccountAddress, baseToken, quoteToken, {
      base:
        remainingBase +
        (makerFee.percentageToken === baseToken ? makerPctUncharged : 0n) +
        (makerFee.fixedToken === baseToken ? makerFee.fixedAmount : 0n),
      quote: fillQuoteAmount + aliceQuoteDeposit,
      eth: makerFee.fixedToken === ETH ? 0n : aliceEthDeposit,
      baseLocked:
        remainingBase + (makerFee.percentageToken === baseToken ? makerPctUncharged : 0n),
      quoteLocked: makerFee.percentageToken === quoteToken ? makerPctUncharged : 0n,
      ethLocked: 0n,
    });

    await expectAccountBalances(contracts.vault, bobAccountAddress, baseToken, quoteToken, {
      base: fillBaseAmount + bobBaseDeposit,
      quote: 0n,
      eth: 0n,
      baseLocked: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await (
      await aliceAccount
        .connect(actors.alice)
        .cancelOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), makerOrderId)
    ).wait();

    const removed = await contracts.tokenSpotOrderBook.getOrder(makerOrderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);

    await expectAccountBalances(contracts.vault, aliceAccountAddress, baseToken, quoteToken, {
      base:
        remainingBase +
        (makerFee.percentageToken === baseToken ? makerPctUncharged : 0n) +
        (makerFee.fixedToken === baseToken ? makerFee.fixedAmount : 0n),
      quote: fillQuoteAmount + aliceQuoteDeposit,
      eth: makerFee.fixedToken === ETH ? 0n : aliceEthDeposit,
      baseLocked: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await expectTokenCustodyForPair(contracts.vault, assets.tokenA, assets.tokenB, [
      aliceAccountAddress,
      bobAccountAddress,
    ]);
  });

  it("expires and sweeps a resting spot order through the real timelock admin without losing custody", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [await actors.carol.getAddress()]);

    const carolAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.carol,
    );
    const carolAccountAddress = await carolAccount.getAddress();
    const baseToken = await assets.tokenA.getAddress();
    const quoteToken = await assets.tokenB.getAddress();

    const baseAmount = ethers.parseEther("5");
    const price = ethers.parseEther("3");
    const makerFee = await getFee(
      contracts.feeManager,
      ETH,
      baseToken,
      baseAmount,
      carolAccountAddress,
      true,
    );

    const baseDeposit = addIfToken(baseAmount, makerFee, baseToken);
    const quoteDeposit = addIfToken(0n, makerFee, quoteToken);
    const ethDeposit = addIfToken(0n, makerFee, ETH);

    await prepareSpotAccount(
      carolAccount,
      actors.carol,
      assets.tokenA,
      assets.tokenB,
      baseDeposit,
      quoteDeposit,
      ethDeposit,
    );

    const latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock) throw new Error("missing latest block");
    const expiry = BigInt(latestBlock.timestamp + 60);

    const nextOrderIdBefore = await contracts.tokenSpotOrderBook.nextOrderId();
    await (
      await carolAccount
        .connect(actors.carol)
        .placeOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          ETH,
          baseToken,
          quoteToken,
          1,
          price,
          baseAmount,
          expiry,
        )
    ).wait();
    const orderId = nextOrderIdBefore;

    await expectAccountBalances(contracts.vault, carolAccountAddress, baseToken, quoteToken, {
      base: baseDeposit,
      quote: quoteDeposit,
      eth: ethDeposit,
      baseLocked: baseAmount + (makerFee.percentageToken === baseToken ? makerFee.percentageAmount : 0n),
      quoteLocked: makerFee.percentageToken === quoteToken ? makerFee.percentageAmount : 0n,
      ethLocked: makerFee.fixedToken === ETH ? makerFee.fixedAmount : 0n,
    });

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await expectRevert(
      carolAccount
        .connect(actors.carol)
        .cancelOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), 999_999n),
    );

    const timelockSigner = await impersonateTimelock(ethers, addresses.sethxTimelock);
    await (
      await contracts.tokenSpotOrderBook
        .connect(timelockSigner)
        .sweepExpiredOrders(baseToken, quoteToken, 1, 10n)
    ).wait();

    const removed = await contracts.tokenSpotOrderBook.getOrder(orderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);
    expect(
      await contracts.tokenSpotOrderBook.getActiveBookOrderCount(baseToken, quoteToken),
    ).to.equal(0n);

    await expectAccountBalances(contracts.vault, carolAccountAddress, baseToken, quoteToken, {
      base: baseDeposit,
      quote: quoteDeposit,
      eth: ethDeposit,
      baseLocked: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await expectTokenCustodyForPair(contracts.vault, assets.tokenA, assets.tokenB, [
      carolAccountAddress,
    ]);
  });
});
