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
const WAD = ONE;
const PRICE_DECIMALS = 8n;
const FUTURES_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const FUTURES_MARGIN_BPS = 1_000n;
const FUTURES_MAINT_BPS = 500n;
const FUTURES_MULTIPLIER = 1n;
const FUTURES_SIZE = 10n ** 15n;
// Use risk level 2 for depth-regression borrow fills: risk level 1 intentionally
// rejects the 50% LTV borrow shape that this multi-maker/multi-taker scenario uses.
const RISK_LEVEL = 2;
const RATE_BPS = 1_000n;
const YEAR = 365n * 24n * 60n * 60n;
const BPS = 10_000n;

const OptionType = { Call: 0, Put: 1 } as const;
const OptionIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const MarginOptionType = { Call: 0, Put: 1 } as const;
const MarginIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const BinaryIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const OracleContext = { OPTION_SETTLEMENT: 4, FUTURE_SETTLEMENT: 2 } as const;

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(seconds = 30n * 24n * 60n * 60n): Promise<bigint> {
  return (await latestTimestamp()) + seconds;
}

async function orderExpiryBefore(marketExpiry: bigint, minimumLead = 300n): Promise<bigint> {
  const now = await latestTimestamp();
  if (marketExpiry <= now + minimumLead + 1n) {
    throw new Error(`market expiry too soon for order: now=${now} marketExpiry=${marketExpiry}`);
  }

  const desired = now + 24n * 60n * 60n;
  const latestAllowed = marketExpiry - minimumLead;
  return desired < latestAllowed ? desired : latestAllowed;
}

function lendingMarketKey(expiry: bigint, riskLevel = RISK_LEVEL): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint64", "uint16"],
      [ETH, expiry, riskLevel],
    ),
  );
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount, await account.getAddress(), await account.vault())).wait();
}

async function depositNft(nft: any, account: any, owner: any, tokenId: bigint) {
  expect(await nft.ownerOf(tokenId), `NFT ${tokenId} owner before deposit`).to.equal(await owner.getAddress());
  await (await nft.connect(owner).setApprovalForAll(await account.getAddress(), true)).wait();
  await (await account.connect(owner).depositNFT721(await nft.getAddress(), tokenId, await account.getAddress(), await account.vault())).wait();
}

async function mintNftTo(nft: any, owner: any): Promise<bigint> {
  const tokenId = await nft.nextTokenId();
  await (await nft.mint(await owner.getAddress())).wait();
  expect(await nft.ownerOf(tokenId)).to.equal(await owner.getAddress());
  return tokenId;
}

function quoteFor(base: bigint, price: bigint): bigint {
  return (base * price) / ONE;
}

function premiumFor(size: bigint, premiumPerUnit: bigint): bigint {
  return (size * premiumPerUnit) / ONE;
}

function normalizePrice(rawPrice: bigint): bigint {
  return rawPrice * 10n ** (18n - PRICE_DECIMALS);
}

function marginForFutures(size: bigint, rawPrice: bigint): bigint {
  return (size * FUTURES_MULTIPLIER * normalizePrice(rawPrice) * FUTURES_MARGIN_BPS) / (BPS * WAD);
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

async function nextOptionExpiry(): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);
  for (let i = 2; i < 18; i++) {
    const candidateDate = new Date(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1),
    );
    const candidate = lastFridayAtNoonUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
    );
    if (candidate > now + 30n * 86_400n) return candidate;
  }
  throw new Error("no option expiry found");
}

async function nextLendingExpiry(monthsAhead = 3): Promise<bigint> {
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
    // Lending markets reject expiries that are not far enough in the future.
    // Keep this stricter than the contract minimum so the long regression test
    // cannot drift into InvalidExpiry while earlier products execute.
    if (candidate > now + 60n * 86_400n) return candidate;
  }

  throw new Error("no valid lending expiry found");
}

async function createNormalAccounts(contracts: any, owners: any[]) {
  const out: any[] = [];
  for (const owner of owners) {
    out.push(
      await createNormalAccount(
        ethers,
        contracts.accountFactory,
        contracts.accountRegistry,
        owner,
      ),
    );
  }
  return out;
}

async function registerFuturesOracle(contracts: any, governance: any, label: string) {
  const oracle = await ethers.deployContract("MockPriceOracle", [label, 8, FUTURES_PRICE]);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  await (await contracts.priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .approveOracleForContext(oracleAddress, OracleContext.FUTURE_SETTLEMENT)
  ).wait();
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
  return { oracle, oracleAddress };
}

async function createFuturesMarket(contracts: any, governance: any, label: string) {
  const { oracle, oracleAddress } = await registerFuturesOracle(contracts, governance, label);
  const marketKey = await contracts.futuresContract.computeMarketKey(oracleAddress);
  await (
    await contracts.futuresContract
      .connect(governance)
      .createMarket(
        label,
        oracleAddress,
        FUTURES_MARGIN_BPS,
        FUTURES_MAINT_BPS,
        FUTURES_MULTIPLIER,
        FUTURES_PRICE,
      )
  ).wait();
  return { marketKey, oracle };
}

async function registerOptionOracle(contracts: any, governance: any, token: string, label: string, price: bigint) {
  const oracle = await ethers.deployContract("MockPriceOracle", [label, 8, price]);
  await oracle.waitForDeployment();
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
      .setTokenAllowedForContext(token, OracleContext.OPTION_SETTLEMENT, true)
  ).wait();
  await (
    await contracts.priceManager
      .connect(governance)
      .registerOracleForTokenContext(token, OracleContext.OPTION_SETTLEMENT, oracleAddress)
  ).wait();
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
  return { oracle, oracleAddress };
}

async function createMarginMarket(contracts: any, governance: any, label: string) {
  const expiry = await nextOptionExpiry();
  const { oracle, oracleAddress } = await registerOptionOracle(
    contracts,
    governance,
    ETH,
    `${label}/ETH`,
    2n * 10n ** 8n,
  );
  await (
    await contracts.marginOptionContract
      .connect(governance)
      .createMarket(MarginOptionType.Call, oracleAddress, 2n * 10n ** 8n, expiry, 10_000n)
  ).wait();
  const count = await contracts.marginOptionContract.marketCount();
  return { marketKey: await contracts.marginOptionContract.marketKeyAt(count - 1n), oracle, expiry };
}

async function createBinaryMarket(contracts: any, governance: any, label: string) {
  const expiry = await nextOptionExpiry();
  const { oracle, oracleAddress } = await registerOptionOracle(
    contracts,
    governance,
    ETH,
    `${label}/ETH`,
    2n * 10n ** 8n,
  );
  await (
    await contracts.binaryMarginOptionContract
      .connect(governance)
      .createMarket(MarginOptionType.Call, oracleAddress, 2n * 10n ** 8n, expiry)
  ).wait();
  const count = await contracts.binaryMarginOptionContract.marketCount();
  return { marketKey: await contracts.binaryMarginOptionContract.marketKeyAt(count - 1n), oracle, expiry };
}

async function assertEthLockedLeTotal(vault: any, accounts: string[]) {
  for (const account of accounts) {
    expect(await vault.ethLocked(account), `locked <= total for ${account}`).to.be.lte(
      await vault.ethBalances(account),
    );
  }
}

describe("Orderbook depth regression - multi-maker and multi-taker integration", function () {
  it("token spot: multiple makers are consumed by one taker, and one maker is consumed by multiple takers", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.dave.getAddress(),
      await actors.lp1.getAddress(),
    ]);

    const [makerA, makerB, makerC, taker, makerSingle, takerA, takerB, takerC] = await createNormalAccounts(contracts, [
      actors.alice,
      actors.bob,
      actors.carol,
      actors.dave,
      actors.alice,
      actors.bob,
      actors.carol,
      actors.lp1,
    ]);
    const base = await assets.tokenA.getAddress();
    const quote = await assets.tokenB.getAddress();
    const price = ONE;
    const chunk = ethers.parseEther("5");

    for (const [maker, owner] of [
      [makerA, actors.alice],
      [makerB, actors.bob],
      [makerC, actors.carol],
    ] as any[]) {
      await depositToken(assets.tokenA, maker, owner, chunk + ethers.parseEther("1"));
      await depositEth(maker, owner, ethers.parseEther("1"));
      await (
        await maker
          .connect(owner)
          .placeOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), ETH, base, quote, 1, price, chunk, 0, ethers.ZeroAddress)
      ).wait();
    }
    await depositToken(assets.tokenB, taker, actors.dave, quoteFor(chunk * 3n, price) + ethers.parseEther("5"));
    await depositEth(taker, actors.dave, ethers.parseEther("1"));
    const firstOrder = (await contracts.tokenSpotOrderBook.nextOrderId()) - 3n;
    await (await taker.connect(actors.dave).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), firstOrder, chunk, ETH, ethers.ZeroAddress)).wait();
    await (await taker.connect(actors.dave).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), firstOrder + 1n, chunk, ETH, ethers.ZeroAddress)).wait();
    await (await taker.connect(actors.dave).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), firstOrder + 2n, chunk, ETH, ethers.ZeroAddress)).wait();
    expect(await contracts.vault.erc20Balances(await taker.getAddress(), base)).to.equal(chunk * 3n);

    await depositToken(assets.tokenA, makerSingle, actors.alice, chunk * 3n + ethers.parseEther("1"));
    await depositEth(makerSingle, actors.alice, ethers.parseEther("1"));
    const orderId = await contracts.tokenSpotOrderBook.nextOrderId();
    await (
      await makerSingle
        .connect(actors.alice)
        .placeOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), ETH, base, quote, 1, price, chunk * 3n, 0, ethers.ZeroAddress)
    ).wait();
    for (const [partialTaker, owner] of [
      [takerA, actors.bob],
      [takerB, actors.carol],
      [takerC, actors.lp1],
    ] as any[]) {
      await depositToken(assets.tokenB, partialTaker, owner, quoteFor(chunk, price) + ethers.parseEther("2"));
      await depositEth(partialTaker, owner, ethers.parseEther("1"));
      await (await partialTaker.connect(owner).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), orderId, chunk, ETH, ethers.ZeroAddress)).wait();
    }
    expect((await contracts.tokenSpotOrderBook.getOrder(orderId)).user).to.equal(ethers.ZeroAddress);
  });

  it("NFT spot: one buyer takes multiple asks and one seller accepts multiple bids", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.dave.getAddress(),
      await actors.lp1.getAddress(),
    ]);

    const [sellerA, sellerB, sellerC, buyer, sellerBid, bidderA, bidderB, bidderC] = await createNormalAccounts(contracts, [
      actors.alice,
      actors.bob,
      actors.carol,
      actors.dave,
      actors.alice,
      actors.bob,
      actors.carol,
      actors.lp1,
    ]);
    const nft = await assets.nft.getAddress();
    const quote = await assets.tokenB.getAddress();
    const price = ethers.parseEther("10");

    for (const [seller, owner] of [
      [sellerA, actors.alice],
      [sellerB, actors.bob],
      [sellerC, actors.carol],
    ] as any[]) {
      const tokenId = await mintNftTo(assets.nft, owner);
      await depositNft(assets.nft, seller, owner, tokenId);
      await (await seller.connect(owner).placeOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), ETH, nft, tokenId, quote, 1, price, 0, ethers.ZeroAddress)).wait();
    }
    await depositToken(assets.tokenB, buyer, actors.dave, price * 3n + ethers.parseEther("5"));
    await depositEth(buyer, actors.dave, ethers.parseEther("1"));
    const firstAsk = (await contracts.nftSpotOrderBook.nextOrderId()) - 3n;
    for (let i = 0n; i < 3n; i++) {
      await (await buyer.connect(actors.dave).acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), firstAsk + i, ETH, ethers.ZeroAddress)).wait();
    }
    expect(await contracts.vault.erc721BalanceCount(await buyer.getAddress(), nft)).to.equal(3n);

    const aliceBidTokenId = await mintNftTo(assets.nft, actors.alice);
    await depositNft(assets.nft, sellerBid, actors.alice, aliceBidTokenId);
    for (const [bidder, owner] of [
      [bidderA, actors.bob],
      [bidderB, actors.carol],
      [bidderC, actors.lp1],
    ] as any[]) {
      await depositToken(assets.tokenB, bidder, owner, price + ethers.parseEther("2"));
      await depositEth(bidder, owner, ethers.parseEther("1"));
      await (await bidder.connect(owner).placeOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), ETH, nft, aliceBidTokenId, quote, 0, price, 0, ethers.ZeroAddress)).wait();
    }
    const firstBid = (await contracts.nftSpotOrderBook.nextOrderId()) - 3n;
    await (await sellerBid.connect(actors.alice).acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), firstBid, ETH, ethers.ZeroAddress)).wait();
    expect(await contracts.vault.erc721Owned(await bidderA.getAddress(), nft, aliceBidTokenId)).to.equal(true);
  });

  it("options, margin options, binary options, futures, and lending books support multi-maker and multi-taker fills", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.dave.getAddress(),
      await actors.lp1.getAddress(),
      await actors.lp2.getAddress(),
    ]);
    const governance = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const [optW1, optW2, optW3, optHolder, optWBig, optH1, optH2, optH3] = await createNormalAccounts(contracts, [
      actors.alice,
      actors.bob,
      actors.carol,
      actors.dave,
      actors.alice,
      actors.bob,
      actors.carol,
      actors.lp1,
    ]);
    const asset = await assets.tokenA.getAddress();
    const optionExpiry = await nextOptionExpiry();
    const optionSize = ethers.parseEther("2");
    const premiumPerUnit = ethers.parseEther("0.05");
    const strike = ethers.parseEther("1");
    for (const [writer, owner] of [[optW1, actors.alice], [optW2, actors.bob], [optW3, actors.carol]] as any[]) {
      await depositToken(assets.tokenA, writer, owner, optionSize);
      const orderId = await contracts.optionsOrderBook.nextOrderId();
      await (await writer.connect(owner).placeOrderOption(await contracts.optionsOrderBook.getAddress(), OptionType.Call, asset, ETH, strike, optionExpiry, await orderExpiryBefore(optionExpiry), ETH, OptionIntent.WriteOption, optionSize, premiumPerUnit, ethers.ZeroAddress)).wait();
      await depositEth(optHolder, actors.dave, premiumFor(optionSize, premiumPerUnit) + ethers.parseEther("1"));
      await (await optHolder.connect(actors.dave).acceptOrderOption(await contracts.optionsOrderBook.getAddress(), orderId, optionSize, ETH, ethers.ZeroAddress)).wait();
    }
    expect(await contracts.optionContract.marketOpenInterest(await contracts.optionContract.computeMarketKey(OptionType.Call, asset, ETH, await contracts.optionContract.normalizeStrike(strike), optionExpiry))).to.equal(optionSize * 3n);

    await depositToken(assets.tokenA, optWBig, actors.alice, optionSize * 3n);
    const bigOptionOrder = await contracts.optionsOrderBook.nextOrderId();
    await (await optWBig.connect(actors.alice).placeOrderOption(await contracts.optionsOrderBook.getAddress(), OptionType.Call, asset, ETH, strike, optionExpiry, await orderExpiryBefore(optionExpiry), ETH, OptionIntent.WriteOption, optionSize * 3n, premiumPerUnit, ethers.ZeroAddress)).wait();
    for (const [holder, owner] of [[optH1, actors.bob], [optH2, actors.carol], [optH3, actors.lp1]] as any[]) {
      await depositEth(holder, owner, premiumFor(optionSize, premiumPerUnit) + ethers.parseEther("1"));
      await (await holder.connect(owner).acceptOrderOption(await contracts.optionsOrderBook.getAddress(), bigOptionOrder, optionSize, ETH, ethers.ZeroAddress)).wait();
    }
    const consumedOptionOrder = await contracts.optionsOrderBook.getOrder(bigOptionOrder);
    expect(consumedOptionOrder.user).to.equal(ethers.ZeroAddress);
    expect(await contracts.optionsOrderBook.isOrderInBook(bigOptionOrder)).to.equal(false);

    const { marketKey: marginKey, expiry: marginExpiry } = await createMarginMarket(contracts, governance, `DEPTH-MARGIN-${await latestTimestamp()}`);
    const { marketKey: binaryKey, expiry: binaryExpiry } = await createBinaryMarket(contracts, governance, `DEPTH-BINARY-${await latestTimestamp()}`);
    const [mWriter, mHolder, bWriter, bHolder] = await createNormalAccounts(contracts, [actors.alice, actors.bob, actors.carol, actors.dave]);
    const marginSize = ethers.parseEther("3");
    const marginPrice = ethers.parseEther("0.1");
    await depositEth(mWriter, actors.alice, ethers.parseEther("20"));
    await depositEth(mHolder, actors.bob, ethers.parseEther("10"));
    const marginOrder = await contracts.marginOptionsOrderBook.nextOrderId();
    await (await mWriter.connect(actors.alice).placeOrderMarginOption(await contracts.marginOptionsOrderBook.getAddress(), marginKey, MarginIntent.WriteOption, marginSize, marginPrice, await orderExpiryBefore(marginExpiry), ETH, ethers.ZeroAddress)).wait();
    await (await mHolder.connect(actors.bob).acceptOrderMarginOption(await contracts.marginOptionsOrderBook.getAddress(), marginOrder, marginSize, ETH, ethers.ZeroAddress)).wait();
    expect(await contracts.marginOptionContract.marketOpenInterest(marginKey)).to.equal(marginSize);

    await depositEth(bWriter, actors.carol, ethers.parseEther("20"));
    await depositEth(bHolder, actors.dave, ethers.parseEther("10"));
    const binaryOrder = await contracts.binaryMarginOptionsOrderBook.nextOrderId();
    await (await bWriter.connect(actors.carol).placeOrderBinaryMarginOption(await contracts.binaryMarginOptionsOrderBook.getAddress(), binaryKey, BinaryIntent.WriteOption, marginSize, marginPrice, await orderExpiryBefore(binaryExpiry), ETH, ethers.ZeroAddress)).wait();
    await (await bHolder.connect(actors.dave).acceptOrderBinaryMarginOption(await contracts.binaryMarginOptionsOrderBook.getAddress(), binaryOrder, marginSize, ETH, ethers.ZeroAddress)).wait();
    expect(await contracts.binaryMarginOptionContract.marketOpenInterest(binaryKey)).to.equal(marginSize);

    const { marketKey: futuresKey } = await createFuturesMarket(contracts, governance, `DEPTH-FUT-${await latestTimestamp()}`);
    const [shortA, shortB, shortC, longTaker, shortBig, longA, longB, longC] = await createNormalAccounts(contracts, [
      actors.alice,
      actors.bob,
      actors.carol,
      actors.dave,
      actors.alice,
      actors.bob,
      actors.carol,
      actors.lp1,
    ]);
    for (const [shortMaker, owner] of [[shortA, actors.alice], [shortB, actors.bob], [shortC, actors.carol]] as any[]) {
      await depositEth(shortMaker, owner, marginForFutures(FUTURES_SIZE, FUTURES_PRICE) + ethers.parseEther("1"));
      await (await shortMaker.connect(owner).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), futuresKey, 1, FUTURES_PRICE, FUTURES_SIZE, 0, ETH, ethers.ZeroAddress)).wait();
    }
    await depositEth(longTaker, actors.dave, marginForFutures(FUTURES_SIZE * 3n, FUTURES_PRICE) + ethers.parseEther("2"));
    const firstFuture = (await contracts.futuresOrderBook.nextOrderId()) - 3n;
    for (let i = 0n; i < 3n; i++) {
      await (await longTaker.connect(actors.dave).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), futuresKey, 0, FUTURES_PRICE, FUTURES_SIZE, 0, ETH, ethers.ZeroAddress)).wait();
    }
    expect((await contracts.futuresContract.getPosition(await longTaker.getAddress(), futuresKey)).size).to.equal(FUTURES_SIZE * 3n);

    await depositEth(shortBig, actors.alice, marginForFutures(FUTURES_SIZE * 3n, FUTURES_PRICE) + ethers.parseEther("2"));
    const bigShortOrder = await contracts.futuresOrderBook.nextOrderId();
    await (await shortBig.connect(actors.alice).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), futuresKey, 1, FUTURES_PRICE, FUTURES_SIZE * 3n, 0, ETH, ethers.ZeroAddress)).wait();
    for (const [long, owner] of [[longA, actors.bob], [longB, actors.carol], [longC, actors.lp1]] as any[]) {
      await depositEth(long, owner, marginForFutures(FUTURES_SIZE, FUTURES_PRICE) + ethers.parseEther("1"));
      await (await long.connect(owner).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), futuresKey, 0, FUTURES_PRICE, FUTURES_SIZE, 0, ETH, ethers.ZeroAddress)).wait();
    }
    expect((await contracts.futuresOrderBook.ordersById(bigShortOrder)).amount).to.equal(0n);

    const lendingExpiry = await nextLendingExpiry();
    // Create these sequentially. The account helpers assert owner account-count deltas,
    // so parallel creations for the same owner can race each other and make the
    // helper observe a larger-than-expected count change.
    const lenderA = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const lenderB = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const lenderC = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.carol);
    const borrower = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.dave);
    const lenderBig = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const borrowerA = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.bob);
    const borrowerB = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.carol);
    const borrowerC = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.lp1);
    const principal = ethers.parseEther("0.2");
    for (const [lender, owner] of [[lenderA, actors.alice], [lenderB, actors.bob], [lenderC, actors.carol]] as any[]) {
      await depositEth(lender, owner, principal + ethers.parseEther("0.1"));
      await (await lender.connect(owner).placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendingExpiry, RISK_LEVEL, RATE_BPS, principal, await orderExpiryBefore(lendingExpiry))).wait();
    }
    await depositEth(borrower, actors.dave, principal * 3n);
    const firstLend = (await contracts.lendingOrderBook.nextOrderId()) - 3n;
    for (let i = 0n; i < 3n; i++) {
      await (await borrower.connect(actors.dave).placeBorrowOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendingExpiry, RISK_LEVEL, principal, RATE_BPS, await orderExpiryBefore(lendingExpiry))).wait();
    }
    const borrowerDebt = await contracts.lendingContract.getDebt(await borrower.getAddress(), lendingMarketKey(lendingExpiry));
    expect(borrowerDebt.principal, "single borrower total debt principal").to.equal(principal * 3n);

    await depositEth(lenderBig, actors.alice, principal * 3n + ethers.parseEther("0.1"));
    await (await lenderBig.connect(actors.alice).placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendingExpiry, RISK_LEVEL, RATE_BPS, principal * 3n, await orderExpiryBefore(lendingExpiry))).wait();
    for (const [b, owner] of [[borrowerA, actors.bob], [borrowerB, actors.carol], [borrowerC, actors.lp1]] as any[]) {
      await depositEth(b, owner, principal);
      await (await b.connect(owner).placeBorrowOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendingExpiry, RISK_LEVEL, principal, RATE_BPS, await orderExpiryBefore(lendingExpiry))).wait();
      const splitDebt = await contracts.lendingContract.getDebt(await b.getAddress(), lendingMarketKey(lendingExpiry));
      expect(splitDebt.principal, "split borrower debt principal").to.equal(principal);
    }

    await assertEthLockedLeTotal(contracts.vault, [
      await mWriter.getAddress(),
      await bWriter.getAddress(),
      await shortA.getAddress(),
      await shortBig.getAddress(),
      await borrower.getAddress(),
    ]);
  });
});
