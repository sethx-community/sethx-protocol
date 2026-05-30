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

const ETH = ethers.ZeroAddress;
const FEE_CONTEXT = "ERC721 Spot Trade";
const BID = 0;
const ASK = 1;

type FeeOutput = {
  fixedAmount: bigint;
  fixedToken: string;
  percentageAmount: bigint;
  percentageToken: string;
};

type AccountQuoteState = {
  quote: bigint;
  eth: bigint;
  quoteLocked: bigint;
  ethLocked: bigint;
};

async function getFee(
  feeManager: any,
  feeToken: string,
  offeredToken: string,
  offeredAmount: bigint,
  account: string,
  isMaker: boolean,
): Promise<FeeOutput> {
  const fee = await feeManager.getFeeForAccount(
    feeToken,
    offeredToken,
    offeredAmount,
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

function feeAmountForToken(fee: FeeOutput, token: string): bigint {
  let amount = 0n;
  if (ethers.getAddress(fee.fixedToken) === ethers.getAddress(token)) {
    amount += fee.fixedAmount;
  }
  if (ethers.getAddress(fee.percentageToken) === ethers.getAddress(token)) {
    amount += fee.percentageAmount;
  }
  return amount;
}

async function depositTokenToAccount(
  token: any,
  account: any,
  owner: any,
  amount: bigint,
) {
  if (amount === 0n) return;
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount, await account.getAddress(), await account.vault())).wait();
}

async function depositEthToAccount(account: any, owner: any, amount: bigint) {
  if (amount === 0n) return;
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function depositNftToAccount(
  nft: any,
  account: any,
  owner: any,
  tokenId: bigint,
) {
  await (await nft.connect(owner).approve(await account.getAddress(), tokenId)).wait();
  await (await account.connect(owner).depositNFT721(await nft.getAddress(), tokenId, await account.getAddress(), await account.vault())).wait();
}

async function expectQuoteState(
  vault: any,
  account: string,
  quoteToken: string,
  expected: AccountQuoteState,
) {
  const quote = await vault.erc20Balances(account, quoteToken);
  const eth = await vault.ethBalances(account);
  const quoteLocked = await vault.erc20Locked(account, quoteToken);
  const ethLocked = await vault.ethLocked(account);

  expect(quote, "quote total").to.equal(expected.quote);
  expect(eth, "ETH total").to.equal(expected.eth);
  expect(quoteLocked, "quote locked").to.equal(expected.quoteLocked);
  expect(ethLocked, "ETH locked").to.equal(expected.ethLocked);

  expect(quoteLocked, "quote locked <= total").to.be.lte(quote);
  expect(ethLocked, "ETH locked <= total").to.be.lte(eth);
}

async function expectNftVaultState(
  vault: any,
  nft: any,
  ownerAccount: string,
  tokenId: bigint,
  expectedOwned: boolean,
  expectedLocked: boolean,
) {
  const nftAddress = await nft.getAddress();
  expect(await vault.erc721Owned(ownerAccount, nftAddress, tokenId), "NFT owned flag").to.equal(
    expectedOwned,
  );
  expect(await vault.erc721Locked(ownerAccount, nftAddress, tokenId), "NFT locked flag").to.equal(
    expectedLocked,
  );
}

async function expectNftCustodyOwner(nft: any, vault: any, tokenId: bigint) {
  expect(await nft.ownerOf(tokenId), "ERC721 custody owner").to.equal(
    await vault.getAddress(),
  );
}

async function expectQuoteCustody(
  vault: any,
  quoteToken: any,
  accounts: string[],
) {
  const quoteAddress = await quoteToken.getAddress();
  let internal = await vault.treasuryBalances(quoteAddress);
  for (const account of accounts) {
    internal += await vault.erc20Balances(account, quoteAddress);
  }

  expect(await quoteToken.balanceOf(await vault.getAddress()), "quote custody").to.equal(
    internal,
  );
}

describe("NFT spot orderbook lifecycle integration", function () {
  it("rejects malicious direct calls to every NFTSpotOrderBook mutating function", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const nft = await assets.nft.getAddress();
    const quoteToken = await assets.tokenB.getAddress();

    await expectRevert(
      contracts.nftSpotOrderBook.connect(actors.attacker).setOrderLimits(1n, 1n),
    );

    await expectRevert(
      contracts.nftSpotOrderBook
        .connect(actors.attacker)
        .placeOrder(ETH, nft, 1n, quoteToken, ASK, ethers.parseEther("10"), 0),
    );

    await expectRevert(
      contracts.nftSpotOrderBook.connect(actors.attacker).acceptOrder(1n, ETH),
    );

    await expectRevert(
      contracts.nftSpotOrderBook.connect(actors.attacker).cancelOrder(1n),
    );

    await expectRevert(
      contracts.nftSpotOrderBook
        .connect(actors.attacker)
        .sweepExpiredOrders(nft, 1n, quoteToken, ASK, 10n),
    );
  });

  it("sells an NFT ask to a buyer account with exact ERC721, quote, fee, and custody reconciliation", async function () {
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
    const nft = await assets.nft.getAddress();
    const quoteToken = await assets.tokenB.getAddress();
    const tokenId = 1n;
    const price = ethers.parseEther("25");

    const takerFee = await getFee(
      contracts.feeManager,
      ETH,
      quoteToken,
      price,
      bobAccountAddress,
      false,
    );

    const bobQuoteDeposit = addIfToken(price, takerFee, quoteToken);
    const bobEthDeposit = addIfToken(0n, takerFee, ETH);

    const treasuryQuoteBefore = await contracts.vault.treasuryBalances(quoteToken);
    const treasuryEthBefore = await contracts.vault.treasuryEthBalance();

    await depositNftToAccount(assets.nft, aliceAccount, actors.alice, tokenId);
    await depositTokenToAccount(assets.tokenB, bobAccount, actors.bob, bobQuoteDeposit);
    await depositEthToAccount(bobAccount, actors.bob, bobEthDeposit);

    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, true, false);
    await expectNftCustodyOwner(assets.nft, contracts.vault, tokenId);

    const nextOrderIdBefore = await contracts.nftSpotOrderBook.nextOrderId();
    await (
      await aliceAccount
        .connect(actors.alice)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quoteToken,
          ASK,
          price,
          0,
        )
    ).wait();

    const makerOrderId = nextOrderIdBefore;
    const order = await contracts.nftSpotOrderBook.getOrder(makerOrderId);
    expect(order.user).to.equal(aliceAccountAddress);
    expect(order.nft).to.equal(nft);
    expect(order.tokenId).to.equal(tokenId);
    expect(order.price).to.equal(price);
    expect(order.side).to.equal(ASK);

    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, true, true);

    await (
      await bobAccount
        .connect(actors.bob)
        .acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), makerOrderId, ETH)
    ).wait();

    const removed = await contracts.nftSpotOrderBook.getOrder(makerOrderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);

    const [bids, asks] = await contracts.nftSpotOrderBook.getOrderBook(nft, tokenId, quoteToken);
    expect(bids.length).to.equal(0);
    expect(asks.length).to.equal(0);

    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, false, false);
    await expectNftVaultState(contracts.vault, assets.nft, bobAccountAddress, tokenId, true, false);
    await expectNftCustodyOwner(assets.nft, contracts.vault, tokenId);

    await expectQuoteState(contracts.vault, aliceAccountAddress, quoteToken, {
      quote: price,
      eth: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });
    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: 0n,
      eth: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    expect(await contracts.vault.treasuryBalances(quoteToken)).to.equal(
      treasuryQuoteBefore + feeAmountForToken(takerFee, quoteToken),
    );
    expect(await contracts.vault.treasuryEthBalance()).to.equal(
      treasuryEthBefore + feeAmountForToken(takerFee, ETH),
    );

    await expectQuoteCustody(contracts.vault, assets.tokenB, [
      aliceAccountAddress,
      bobAccountAddress,
    ]);
  });

  it("fills a resting bid when the seller accepts, and reconciles maker fee budgets and NFT transfer", async function () {
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
    const nft = await assets.nft.getAddress();
    const quoteToken = await assets.tokenB.getAddress();
    const tokenId = 1n;
    const price = ethers.parseEther("12");

    const makerFee = await getFee(
      contracts.feeManager,
      ETH,
      quoteToken,
      price,
      bobAccountAddress,
      true,
    );

    const bobQuoteDeposit = addIfToken(price, makerFee, quoteToken);
    const bobEthDeposit = addIfToken(0n, makerFee, ETH);

    await depositNftToAccount(assets.nft, aliceAccount, actors.alice, tokenId);
    await depositTokenToAccount(assets.tokenB, bobAccount, actors.bob, bobQuoteDeposit);
    await depositEthToAccount(bobAccount, actors.bob, bobEthDeposit);

    const nextOrderIdBefore = await contracts.nftSpotOrderBook.nextOrderId();
    await (
      await bobAccount
        .connect(actors.bob)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quoteToken,
          BID,
          price,
          0,
        )
    ).wait();

    const bidOrderId = nextOrderIdBefore;
    const bid = await contracts.nftSpotOrderBook.getOrder(bidOrderId);
    expect(bid.user).to.equal(bobAccountAddress);
    expect(bid.fixedFeeAmount).to.equal(makerFee.fixedAmount);
    expect(bid.percentageFeeAmount).to.equal(makerFee.percentageAmount);

    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: bobQuoteDeposit,
      eth: bobEthDeposit,
      quoteLocked: price + feeAmountForToken(makerFee, quoteToken),
      ethLocked: feeAmountForToken(makerFee, ETH),
    });

    await (
      await aliceAccount
        .connect(actors.alice)
        .acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), bidOrderId, ETH)
    ).wait();

    const removed = await contracts.nftSpotOrderBook.getOrder(bidOrderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);

    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, false, false);
    await expectNftVaultState(contracts.vault, assets.nft, bobAccountAddress, tokenId, true, false);

    await expectQuoteState(contracts.vault, aliceAccountAddress, quoteToken, {
      quote: price,
      eth: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });
    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: 0n,
      eth: 0n,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await expectQuoteCustody(contracts.vault, assets.tokenB, [
      aliceAccountAddress,
      bobAccountAddress,
    ]);
  });

  it("cancels an NFT ask and releases only the locked NFT without withdrawing custody", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [await actors.alice.getAddress()]);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const aliceAccountAddress = await aliceAccount.getAddress();
    const nft = await assets.nft.getAddress();
    const quoteToken = await assets.tokenB.getAddress();
    const tokenId = 1n;
    const price = ethers.parseEther("8");

    await depositNftToAccount(assets.nft, aliceAccount, actors.alice, tokenId);

    const nextOrderIdBefore = await contracts.nftSpotOrderBook.nextOrderId();
    await (
      await aliceAccount
        .connect(actors.alice)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quoteToken,
          ASK,
          price,
          0,
        )
    ).wait();

    const orderId = nextOrderIdBefore;
    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, true, true);

    await (
      await aliceAccount
        .connect(actors.alice)
        .cancelOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), orderId)
    ).wait();

    const removed = await contracts.nftSpotOrderBook.getOrder(orderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);
    await expectNftVaultState(contracts.vault, assets.nft, aliceAccountAddress, tokenId, true, false);
    await expectNftCustodyOwner(assets.nft, contracts.vault, tokenId);

    await expectRevert(
      aliceAccount
        .connect(actors.alice)
        .cancelOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), orderId),
    );
  });

  it("sweeps an expired bid through the deployed timelock admin and releases locked quote and fee budgets once", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [await actors.bob.getAddress()]);

    const bobAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const bobAccountAddress = await bobAccount.getAddress();
    const nft = await assets.nft.getAddress();
    const quoteToken = await assets.tokenB.getAddress();
    const tokenId = 1n;
    const price = ethers.parseEther("9");

    const makerFee = await getFee(
      contracts.feeManager,
      ETH,
      quoteToken,
      price,
      bobAccountAddress,
      true,
    );

    const bobQuoteDeposit = addIfToken(price, makerFee, quoteToken);
    const bobEthDeposit = addIfToken(0n, makerFee, ETH);

    await depositTokenToAccount(assets.tokenB, bobAccount, actors.bob, bobQuoteDeposit);
    await depositEthToAccount(bobAccount, actors.bob, bobEthDeposit);

    const latest = await ethers.provider.getBlock("latest");
    const expiry = BigInt(latest!.timestamp + 5);

    const nextOrderIdBefore = await contracts.nftSpotOrderBook.nextOrderId();
    await (
      await bobAccount
        .connect(actors.bob)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quoteToken,
          BID,
          price,
          expiry,
        )
    ).wait();

    const orderId = nextOrderIdBefore;

    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: bobQuoteDeposit,
      eth: bobEthDeposit,
      quoteLocked: price + feeAmountForToken(makerFee, quoteToken),
      ethLocked: feeAmountForToken(makerFee, ETH),
    });

    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine", []);

    await expectRevert(
      bobAccount
        .connect(actors.bob)
        .acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), orderId, ETH),
    );

    const timelock = await impersonateTimelock(ethers, addresses.sethxTimelock);
    await (
      await contracts.nftSpotOrderBook
        .connect(timelock)
        .sweepExpiredOrders(nft, tokenId, quoteToken, BID, 10n)
    ).wait();

    const removed = await contracts.nftSpotOrderBook.getOrder(orderId);
    expect(removed.user).to.equal(ethers.ZeroAddress);

    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: bobQuoteDeposit,
      eth: bobEthDeposit,
      quoteLocked: 0n,
      ethLocked: 0n,
    });

    await (
      await contracts.nftSpotOrderBook
        .connect(timelock)
        .sweepExpiredOrders(nft, tokenId, quoteToken, BID, 10n)
    ).wait();

    await expectQuoteState(contracts.vault, bobAccountAddress, quoteToken, {
      quote: bobQuoteDeposit,
      eth: bobEthDeposit,
      quoteLocked: 0n,
      ethLocked: 0n,
    });
  });
});
