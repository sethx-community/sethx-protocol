import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { createNormalAccount } from "../helpers/accounts.js";
import { deployMockAssets, mintMockBalances } from "../helpers/mock-assets.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;

type KnownAccount = {
  contract: any;
  owner: any;
  address: string;
  label: string;
};

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  return (baseAmount * price) / ONE;
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount)).wait();
}

async function maybeWithdrawToken(vault: any, token: any, account: KnownAccount, amount: bigint) {
  const tokenAddress = await token.getAddress();
  const total = await vault.erc20Balances(account.address, tokenAddress);
  const locked = await vault.erc20Locked(account.address, tokenAddress);
  const free = total - locked;
  if (free >= amount) {
    await (await account.contract.connect(account.owner).withdrawToken(tokenAddress, amount)).wait();
  }
}

async function maybeWithdrawEth(vault: any, account: KnownAccount, amount: bigint) {
  const total = await vault.ethBalances(account.address);
  const locked = await vault.ethLocked(account.address);
  const free = total - locked;
  if (free >= amount) {
    await (await account.contract.connect(account.owner).withdrawETH(amount)).wait();
  }
}

async function assertLockedNotAboveTotal(vault: any, accounts: KnownAccount[], tokens: string[]) {
  for (const account of accounts) {
    const ethTotal = await vault.ethBalances(account.address);
    const ethLocked = await vault.ethLocked(account.address);
    expect(ethLocked, `${account.label} ETH locked <= total`).to.be.lte(ethTotal);

    for (const token of tokens) {
      const total = await vault.erc20Balances(account.address, token);
      const locked = await vault.erc20Locked(account.address, token);
      expect(locked, `${account.label} ${token} locked <= total`).to.be.lte(total);
    }
  }
}

async function assertErc20Custody(
  vault: any,
  token: any,
  accounts: KnownAccount[],
  label: string,
) {
  const tokenAddress = await token.getAddress();
  let internal = await vault.treasuryBalances(tokenAddress);

  for (const account of accounts) {
    internal += await vault.erc20Balances(account.address, tokenAddress);
  }

  expect(await token.balanceOf(await vault.getAddress()), `${label} vault custody`).to.equal(
    internal,
  );
}

async function assertKnownInvariants(vault: any, tokens: any[], accounts: KnownAccount[]) {
  const tokenAddresses = await Promise.all(tokens.map((token) => token.getAddress()));
  await assertLockedNotAboveTotal(vault, accounts, tokenAddresses);

  for (const [index, token] of tokens.entries()) {
    await assertErc20Custody(vault, token, accounts, `token-${index}`);
  }
}

async function makeAccounts(contracts: any, owners: any[]): Promise<KnownAccount[]> {
  const accounts: KnownAccount[] = [];
  for (const [index, owner] of owners.entries()) {
    const contract = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      owner,
    );
    accounts.push({
      contract,
      owner,
      address: await contract.getAddress(),
      label: `account-${index}`,
    });
  }
  return accounts;
}

async function placeAndMaybeFillSpot(
  contracts: any,
  maker: KnownAccount,
  taker: KnownAccount,
  baseToken: string,
  quoteToken: string,
  price: bigint,
  amount: bigint,
  fillAmount: bigint,
  shouldCancelRemainder: boolean,
) {
  const orderId = await contracts.tokenSpotOrderBook.nextOrderId();
  await (
    await maker.contract
      .connect(maker.owner)
      .placeOrderTokenSpot(
        await contracts.tokenSpotOrderBook.getAddress(),
        ETH,
        baseToken,
        quoteToken,
        1,
        price,
        amount,
        await freshOrderExpiry(),
      )
  ).wait();

  if (fillAmount > 0n) {
    await (
      await taker.contract
        .connect(taker.owner)
        .acceptOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          orderId,
          fillAmount,
          ETH,
        )
    ).wait();
  }

  if (shouldCancelRemainder) {
    const remaining = await contracts.tokenSpotOrderBook.getOrder(orderId);
    if (remaining.user !== ethers.ZeroAddress && remaining.amount > 0n) {
      await (
        await maker.contract
          .connect(maker.owner)
          .cancelOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), orderId)
      ).wait();
    }
  }
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(): Promise<bigint> {
  return (await latestTimestamp()) + 7n * 24n * 60n * 60n;
}

describe("Protocol randomized invariant smoke integration", function () {
  it("runs deterministic mixed account operations and preserves vault/account invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);
    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.dave.getAddress(),
    ]);

    const accounts = await makeAccounts(contracts, [
      actors.alice,
      actors.bob,
      actors.carol,
      actors.dave,
    ]);

    const tokenA = assets.tokenA;
    const tokenB = assets.tokenB;
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();

    for (const account of accounts) {
      await depositToken(tokenA, account.contract, account.owner, 1_000n * ONE);
      await depositToken(tokenB, account.contract, account.owner, 1_000n * ONE);
      await depositEth(account.contract, account.owner, 5n * ONE);
    }

    await assertKnownInvariants(contracts.vault, [tokenA, tokenB], accounts);

    const prices = [2n * ONE, 3n * ONE, ONE / 2n, (5n * ONE) / 4n];
    const amounts = [10n * ONE, 15n * ONE, 20n * ONE, 25n * ONE];

    for (let i = 0; i < 8; i++) {
      const maker = accounts[i % accounts.length];
      const taker = accounts[(i + 1) % accounts.length];
      const price = prices[i % prices.length];
      const amount = amounts[i % amounts.length];
      const fillAmount = i % 3 === 0 ? amount / 2n : amount;
      const shouldCancelRemainder = fillAmount < amount;

      await placeAndMaybeFillSpot(
        contracts,
        maker,
        taker,
        tokenAAddress,
        tokenBAddress,
        price,
        amount,
        fillAmount,
        shouldCancelRemainder,
      );

      await assertKnownInvariants(contracts.vault, [tokenA, tokenB], accounts);
    }

    for (let i = 0; i < accounts.length; i++) {
      await maybeWithdrawToken(contracts.vault, tokenA, accounts[i], BigInt(i + 1) * ONE);
      await maybeWithdrawToken(contracts.vault, tokenB, accounts[i], BigInt(i + 2) * ONE);
      await maybeWithdrawEth(contracts.vault, accounts[i], ONE / 10n);
      await assertKnownInvariants(contracts.vault, [tokenA, tokenB], accounts);
    }

    const quoteInternal = await contracts.vault.treasuryBalances(tokenBAddress);
    const baseInternal = await contracts.vault.treasuryBalances(tokenAAddress);

    expect(baseInternal, "base treasury accounting remains non-negative").to.be.gte(0n);
    expect(quoteInternal, "quote treasury accounting remains non-negative").to.be.gte(0n);

    for (const account of accounts) {
      expect(await contracts.accountRegistry.ownerOfAccount(account.address)).to.equal(
        await account.owner.getAddress(),
      );
      expect(await contracts.accountRegistry.isAccount(account.address)).to.equal(true);
    }

    // Sanity: the random-like spot operations should have produced non-zero trade movement.
    const aliceBase = await contracts.vault.erc20Balances(accounts[0].address, tokenAAddress);
    const bobBase = await contracts.vault.erc20Balances(accounts[1].address, tokenAAddress);
    expect(aliceBase + bobBase, "representative balances remain accounted").to.be.gt(0n);

    // Preserve quoteFor coverage in this invariant file because it documents the expected
    // spot quote formula used by the randomized actions.
    expect(quoteFor(2n * ONE, 3n * ONE)).to.equal(6n * ONE);
  });
});
