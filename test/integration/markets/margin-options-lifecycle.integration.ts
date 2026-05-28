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

const ONE = 10n ** 18n;
const ETH = ethers.ZeroAddress;

const OracleContext = {
  OPTION_SETTLEMENT: 4,
} as const;

const MarginOptionType = {
  Call: 0,
  Put: 1,
} as const;

const MarginIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;

const BinaryIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;

type EthSnapshot = {
  contractBalance: bigint;
  treasury: bigint;
  accounts: Record<string, { total: bigint; locked: bigint }>;
};

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function mineToTimestamp(timestamp: bigint) {
  const latest = await latestTimestamp();
  if (latest >= timestamp) return;
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
}

function premiumFor(amount: bigint, premiumPerUnit: bigint): bigint {
  return (amount * premiumPerUnit) / ONE;
}

async function deployMockOracle(pair: string, decimals: number, price: bigint) {
  const oracle = await ethers.deployContract("MockPriceOracle", [
    pair,
    decimals,
    price,
  ]);
  await oracle.waitForDeployment();
  return oracle;
}

async function registerOptionSettlementOracle(
  contracts: any,
  governance: any,
  token: string,
  oracle: any,
  label: string,
) {
  const oracleAddress = await oracle.getAddress();

  await (await contracts.priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .approveOracleForContext(oracleAddress, OracleContext.OPTION_SETTLEMENT)
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .setOracleMetadata(oracleAddress, token, label, "Local margin option oracle")
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .setTokenAllowedForContext(token, OracleContext.OPTION_SETTLEMENT, true)
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .registerOracleForTokenContext(token, OracleContext.OPTION_SETTLEMENT, oracleAddress)
  ).wait();
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();

  expect(
    await contracts.priceManager.isOracleUsableForContext(
      oracleAddress,
      OracleContext.OPTION_SETTLEMENT,
    ),
  ).to.equal(true);

  return oracleAddress;
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function snapshotEth(vault: any, accounts: string[]): Promise<EthSnapshot> {
  const out: EthSnapshot = {
    contractBalance: await ethers.provider.getBalance(await vault.getAddress()),
    treasury: await vault.treasuryEthBalance(),
    accounts: {},
  };

  for (const account of accounts.map((a) => ethers.getAddress(a))) {
    out.accounts[account] = {
      total: await vault.ethBalances(account),
      locked: await vault.ethLocked(account),
    };
  }
  return out;
}

async function expectEthDelta(vault: any, accounts: string[], before: EthSnapshot) {
  let internalDelta = (await vault.treasuryEthBalance()) - before.treasury;

  for (const account of accounts.map((a) => ethers.getAddress(a))) {
    const start = before.accounts[account] ?? { total: 0n, locked: 0n };
    const total = await vault.ethBalances(account);
    const locked = await vault.ethLocked(account);
    expect(locked, `locked <= total for ${account}`).to.be.lte(total);
    internalDelta += total - start.total;
  }

  expect(
    (await ethers.provider.getBalance(await vault.getAddress())) - before.contractBalance,
    "ETH custody delta",
  ).to.equal(internalDelta);
}

async function getFee(
  feeManager: any,
  feeToken: string,
  premium: bigint,
  account: string,
  context: string,
) {
  const fee = await feeManager.getFeeForAccount(
    feeToken,
    ETH,
    premium,
    context,
    account,
    false,
  );
  let total = 0n;
  if (ethers.getAddress(fee.fixedToken) === ethers.getAddress(ETH)) {
    total += fee.fixedAmount;
  }
  if (ethers.getAddress(fee.percentageToken) === ethers.getAddress(ETH)) {
    total += fee.percentageAmount;
  }
  return total;
}

async function createMarginMarket(contracts: any, governance: any) {
  const now = await latestTimestamp();
  const expiry = now + 7n * 86_400n;
  const oracle = await deployMockOracle("MARGIN/ETH", 8, 2n * 10n ** 8n);
  const oracleAddress = await registerOptionSettlementOracle(
    contracts,
    governance,
    ETH,
    oracle,
    `MARGIN/ETH ${now}`,
  );

  const strikeRaw = 2n * 10n ** 8n;
  const incrementRaw = 10n ** 8n;
  const collateralBps = 10_000n;

  await (
    await contracts.marginOptionContract
      .connect(governance)
      .createMarket(
        `MARGIN-${now}`,
        MarginOptionType.Call,
        oracleAddress,
        strikeRaw,
        incrementRaw,
        expiry,
        collateralBps,
      )
  ).wait();

  const count = await contracts.marginOptionContract.marketCount();
  const marketKey = await contracts.marginOptionContract.marketKeyAt(count - 1n);

  return { marketKey, oracle, oracleAddress, expiry, strikeRaw };
}

async function createBinaryMarket(contracts: any, governance: any) {
  const now = await latestTimestamp();
  const expiry = now + 8n * 86_400n;
  const oracle = await deployMockOracle("BINARY/ETH", 8, 2n * 10n ** 8n);
  const oracleAddress = await registerOptionSettlementOracle(
    contracts,
    governance,
    ETH,
    oracle,
    `BINARY/ETH ${now}`,
  );

  const strikeRaw = 2n * 10n ** 8n;
  const incrementRaw = 10n ** 8n;

  await (
    await contracts.binaryMarginOptionContract
      .connect(governance)
      .createMarket(
        `BINARY-${now}`,
        MarginOptionType.Call,
        oracleAddress,
        strikeRaw,
        incrementRaw,
        expiry,
      )
  ).wait();

  const count = await contracts.binaryMarginOptionContract.marketCount();
  const marketKey = await contracts.binaryMarginOptionContract.marketKeyAt(count - 1n);

  return { marketKey, oracle, oracleAddress, expiry, strikeRaw };
}

describe("Margin and binary margin options lifecycle integration", function () {
  it("rejects malicious direct calls to margin option orderbooks and ledgers", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attacker = actors.attacker;
    const zeroKey = ethers.ZeroHash;

    await expectRevert(
      contracts.marginOptionsOrderBook.connect(attacker).setOrderLimits(1n, 1n),
    );
    await expectRevert(
      contracts.marginOptionsOrderBook
        .connect(attacker)
        .placeOrder(zeroKey, MarginIntent.BuyOption, ONE, ONE / 10n, 0n, ETH),
    );
    await expectRevert(
      contracts.marginOptionsOrderBook.connect(attacker).acceptOrder(1n, ONE, ETH),
    );
    await expectRevert(
      contracts.marginOptionsOrderBook.connect(attacker).cancelOrder(1n),
    );

    await expectRevert(
      contracts.marginOptionContract.connect(attacker).setPriceManager(await contracts.priceManager.getAddress()),
    );
    await expectRevert(
      contracts.marginOptionContract
        .connect(attacker)
        .createMarket("BAD", MarginOptionType.Call, await contracts.priceManager.getAddress(), 1n, 1n, 1n, 1n),
    );
    await expectRevert(
      contracts.marginOptionContract.connect(attacker).setMarketActive(zeroKey, false),
    );
    await expectRevert(
      contracts.marginOptionContract.connect(attacker).registerNewPosition(zeroKey, await attacker.getAddress(), await attacker.getAddress(), ONE),
    );
    await expectRevert(
      contracts.marginOptionContract.connect(attacker).settleMarket(zeroKey),
    );
    await expectRevert(
      contracts.marginOptionContract.connect(attacker).claim(zeroKey, ONE),
    );
    await expectRevert(
      contracts.marginOptionContract.connect(attacker).reclaimWriterMargin(zeroKey),
    );

    await expectRevert(
      contracts.binaryMarginOptionsOrderBook.connect(attacker).setOrderLimits(1n, 1n),
    );
    await expectRevert(
      contracts.binaryMarginOptionsOrderBook
        .connect(attacker)
        .placeOrder(zeroKey, BinaryIntent.BuyOption, ONE, ONE / 10n, 0n, ETH),
    );
    await expectRevert(
      contracts.binaryMarginOptionsOrderBook.connect(attacker).acceptOrder(1n, ONE, ETH),
    );
    await expectRevert(
      contracts.binaryMarginOptionsOrderBook.connect(attacker).cancelOrder(1n),
    );
    await expectRevert(
      contracts.binaryMarginOptionContract.connect(attacker).setPriceManager(await contracts.priceManager.getAddress()),
    );
    await expectRevert(
      contracts.binaryMarginOptionContract.connect(attacker).setMarketActive(zeroKey, false),
    );
    await expectRevert(
      contracts.binaryMarginOptionContract.connect(attacker).settleMarket(zeroKey),
    );
  });

  it("writes, buys, settles, claims, and reclaims a margin call option through Accounts", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const governance = await impersonateTimelock(ethers, addresses.sethxTimelock);

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

    const { marketKey, oracle, expiry } = await createMarginMarket(contracts, governance);

    const size = ethers.parseEther("10");
    const askPrice = ethers.parseEther("0.1");
    const premium = premiumFor(size, askPrice);
    const margin = await contracts.marginOptionContract.getRequiredMargin(marketKey, size);
    const holderFee = await getFee(
      contracts.feeManager,
      ETH,
      premium,
      holderAddress,
      "Margin Option Trade",
    );

    await depositEth(writer, actors.alice, margin + ethers.parseEther("2"));
    await depositEth(holder, actors.bob, premium + holderFee + ethers.parseEther("2"));

    const baseline = await snapshotEth(contracts.vault, [writerAddress, holderAddress]);
    const orderId = await contracts.marginOptionsOrderBook.nextOrderId();
    const orderExpiry = (await latestTimestamp()) + 3_600n;

    await (
      await writer
        .connect(actors.alice)
        .placeOrderMarginOption(
          await contracts.marginOptionsOrderBook.getAddress(),
          marketKey,
          MarginIntent.WriteOption,
          size,
          askPrice,
          orderExpiry,
          ETH,
        )
    ).wait();

    await (
      await holder
        .connect(actors.bob)
        .acceptOrderMarginOption(
          await contracts.marginOptionsOrderBook.getAddress(),
          orderId,
          size,
          ETH,
        )
    ).wait();

    expect(await contracts.marginOptionContract.marketOpenInterest(marketKey)).to.equal(size);
    expect(await contracts.vault.ethLocked(writerAddress)).to.equal(margin);

    await mineToTimestamp(expiry + 1n);
    await (await oracle.setPrice(25n * 10n ** 7n)).wait();
    await (await contracts.marginOptionContract.connect(actors.attacker).settleMarket(marketKey)).wait();

    const payoutPerUnit = await contracts.marginOptionContract.getPayoutPerUnit(marketKey);
    const expectedPayout = (size * payoutPerUnit) / ONE;
    expect(expectedPayout).to.equal(ethers.parseEther("5"));

    await (
      await holder
        .connect(actors.bob)
        .claimMarginOption(await contracts.marginOptionContract.getAddress(), marketKey, size)
    ).wait();
    expect(await contracts.marginOptionContract.marketOpenInterest(marketKey)).to.equal(0n);

    await (
      await writer
        .connect(actors.alice)
        .reclaimWriterMarginOption(await contracts.marginOptionContract.getAddress(), marketKey)
    ).wait();

    expect(await contracts.vault.ethLocked(writerAddress)).to.equal(0n);
    await expectEthDelta(contracts.vault, [writerAddress, holderAddress], baseline);
  });

  it("writes, buys, settles, and claims an in-the-money binary margin call through Accounts", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const governance = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const writer = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.carol,
    );
    const holder = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.dave,
    );
    const writerAddress = await writer.getAddress();
    const holderAddress = await holder.getAddress();

    const { marketKey, oracle, expiry } = await createBinaryMarket(contracts, governance);

    const payoutAmount = ethers.parseEther("10");
    const askPrice = ethers.parseEther("0.1");
    const premium = premiumFor(payoutAmount, askPrice);
    const holderFee = await getFee(
      contracts.feeManager,
      ETH,
      premium,
      holderAddress,
      "Binary Margin Option Trade",
    );

    await depositEth(writer, actors.carol, payoutAmount + ethers.parseEther("2"));
    await depositEth(holder, actors.dave, premium + holderFee + ethers.parseEther("2"));

    const baseline = await snapshotEth(contracts.vault, [writerAddress, holderAddress]);
    const orderId = await contracts.binaryMarginOptionsOrderBook.nextOrderId();
    const orderExpiry = (await latestTimestamp()) + 3_600n;

    await (
      await writer
        .connect(actors.carol)
        .placeOrderBinaryMarginOption(
          await contracts.binaryMarginOptionsOrderBook.getAddress(),
          marketKey,
          BinaryIntent.WriteOption,
          payoutAmount,
          askPrice,
          orderExpiry,
          ETH,
        )
    ).wait();

    await (
      await holder
        .connect(actors.dave)
        .acceptOrderBinaryMarginOption(
          await contracts.binaryMarginOptionsOrderBook.getAddress(),
          orderId,
          payoutAmount,
          ETH,
        )
    ).wait();

    expect(await contracts.binaryMarginOptionContract.marketOpenInterest(marketKey)).to.equal(
      payoutAmount,
    );
    expect(await contracts.vault.ethLocked(writerAddress)).to.equal(payoutAmount);

    await mineToTimestamp(expiry + 1n);
    await (await oracle.setPrice(25n * 10n ** 7n)).wait();
    await (
      await contracts.binaryMarginOptionContract.connect(actors.attacker).settleMarket(marketKey)
    ).wait();
    expect(await contracts.binaryMarginOptionContract.isInTheMoney(marketKey)).to.equal(true);

    await (
      await holder
        .connect(actors.dave)
        .claimBinaryMarginOption(
          await contracts.binaryMarginOptionContract.getAddress(),
          marketKey,
          payoutAmount,
        )
    ).wait();

    expect(await contracts.binaryMarginOptionContract.marketOpenInterest(marketKey)).to.equal(0n);
    expect(await contracts.vault.ethLocked(writerAddress)).to.equal(0n);
    await expectEthDelta(contracts.vault, [writerAddress, holderAddress], baseline);
  });
});
