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

class DeterministicRng {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed;
  }

  next(): bigint {
    // Linear congruential generator. Deterministic, cheap, and adequate for test scheduling.
    this.state = (1103515245n * this.state + 12345n) % (2n ** 31n);
    return this.state;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new Error("maxExclusive must be positive");
    return Number(this.next() % BigInt(maxExclusive));
  }

  bool(): boolean {
    return this.int(2) === 0;
  }
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(): Promise<bigint> {
  return (await latestTimestamp()) + 14n * 24n * 60n * 60n;
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount, await account.getAddress(), await account.vault())).wait();
}

async function freeEth(vault: any, account: string): Promise<bigint> {
  return (await vault.ethBalances(account)) - (await vault.ethLocked(account));
}

async function freeToken(vault: any, account: string, token: string): Promise<bigint> {
  return (await vault.erc20Balances(account, token)) - (await vault.erc20Locked(account, token));
}

async function maybeWithdrawEth(vault: any, account: KnownAccount, amount: bigint) {
  if ((await freeEth(vault, account.address)) >= amount) {
    await (await account.contract.connect(account.owner).withdrawETH(amount)).wait();
  }
}

async function maybeWithdrawToken(vault: any, account: KnownAccount, token: string, amount: bigint) {
  if ((await freeToken(vault, account.address, token)) >= amount) {
    await (await account.contract.connect(account.owner).withdrawToken(token, amount)).wait();
  }
}

async function assertLockedNotAboveTotal(vault: any, accounts: KnownAccount[], tokenAddresses: string[]) {
  for (const account of accounts) {
    const ethTotal = await vault.ethBalances(account.address);
    const ethLocked = await vault.ethLocked(account.address);
    expect(ethLocked, `${account.label} ETH locked <= total`).to.be.lte(ethTotal);

    for (const token of tokenAddresses) {
      const total = await vault.erc20Balances(account.address, token);
      const locked = await vault.erc20Locked(account.address, token);
      expect(locked, `${account.label} ${token} locked <= total`).to.be.lte(total);
    }
  }
}

async function assertErc20Custody(vault: any, token: any, accounts: KnownAccount[], label: string) {
  const tokenAddress = await token.getAddress();
  let internal = await vault.treasuryBalances(tokenAddress);
  for (const account of accounts) {
    internal += await vault.erc20Balances(account.address, tokenAddress);
  }

  expect(await token.balanceOf(await vault.getAddress()), `${label} vault custody`).to.equal(internal);
}

async function assertAccountRegistry(accounts: KnownAccount[], accountRegistry: any) {
  for (const account of accounts) {
    expect(await accountRegistry.ownerOfAccount(account.address), `${account.label} owner`).to.equal(
      await account.owner.getAddress(),
    );
    expect(await accountRegistry.isAccount(account.address), `${account.label} registry account`).to.equal(true);
  }
}

async function assertAllInvariants(vault: any, accountRegistry: any, tokens: any[], accounts: KnownAccount[]) {
  const tokenAddresses = await Promise.all(tokens.map((token) => token.getAddress()));
  await assertLockedNotAboveTotal(vault, accounts, tokenAddresses);
  await assertAccountRegistry(accounts, accountRegistry);
  for (const [index, token] of tokens.entries()) {
    await assertErc20Custody(vault, token, accounts, `token-${index}`);
  }
}

async function createAccounts(contracts: any, owners: any[]): Promise<KnownAccount[]> {
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
      label: `long-run-account-${index}`,
    });
  }
  return accounts;
}

async function placeSpotOrder(
  contracts: any,
  maker: KnownAccount,
  baseToken: string,
  quoteToken: string,
  side: number,
  price: bigint,
  amount: bigint,
): Promise<bigint> {
  const orderId = await contracts.tokenSpotOrderBook.nextOrderId();
  await (
    await maker.contract
      .connect(maker.owner)
      .placeOrderTokenSpot(
        await contracts.tokenSpotOrderBook.getAddress(),
        ETH,
        baseToken,
        quoteToken,
        side,
        price,
        amount,
        await freshOrderExpiry(),
      )
  ).wait();
  return orderId;
}

async function maybeAcceptSpotOrder(
  contracts: any,
  taker: KnownAccount,
  orderId: bigint,
  amount: bigint,
) {
  const order = await contracts.tokenSpotOrderBook.getOrder(orderId);
  if (order.user === ethers.ZeroAddress || order.amount === 0n) return;
  const fillAmount = amount > order.amount ? order.amount : amount;
  await (
    await taker.contract
      .connect(taker.owner)
      .acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), orderId, fillAmount, ETH)
  ).wait();
}

async function maybeCancelSpotOrder(contracts: any, maker: KnownAccount, orderId: bigint) {
  const order = await contracts.tokenSpotOrderBook.getOrder(orderId);
  if (order.user === maker.address && order.amount > 0n) {
    await (
      await maker.contract
        .connect(maker.owner)
        .cancelOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), orderId)
    ).wait();
  }
}

describe("Protocol long-run randomized invariant integration", function () {
  it("runs a deterministic long mixed spot/order/withdrawal simulation and preserves custody invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);
    const owners = [actors.alice, actors.bob, actors.carol, actors.dave, actors.erin, actors.frank].filter(
      Boolean,
    );
    const ownerAddresses = await Promise.all(owners.map((owner: any) => owner.getAddress()));
    await mintMockBalances(ethers, assets, ownerAddresses);

    const accounts = await createAccounts(contracts, owners);
    const tokenA = assets.tokenA;
    const tokenB = assets.tokenB;
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();

    for (const account of accounts) {
      await depositToken(tokenA, account.contract, account.owner, 3_000n * ONE);
      await depositToken(tokenB, account.contract, account.owner, 3_000n * ONE);
      await depositEth(account.contract, account.owner, 10n * ONE);
    }

    await assertAllInvariants(contracts.vault, contracts.accountRegistry, [tokenA, tokenB], accounts);

    const rng = new DeterministicRng(0x5e7a2026n);
    const openOrders: Array<{ id: bigint; makerIndex: number }> = [];
    const prices = [ONE / 2n, ONE, (3n * ONE) / 2n, 2n * ONE, 3n * ONE];
    const amounts = [2n * ONE, 3n * ONE, 5n * ONE, 8n * ONE, 13n * ONE];

    for (let step = 0; step < 72; step++) {
      const op = rng.int(5);
      const accountIndex = rng.int(accounts.length);
      const counterpartyIndex = (accountIndex + 1 + rng.int(accounts.length - 1)) % accounts.length;
      const account = accounts[accountIndex];
      const counterparty = accounts[counterpartyIndex];
      const price = prices[rng.int(prices.length)];
      const amount = amounts[rng.int(amounts.length)];

      if (op === 0 || openOrders.length === 0) {
        // Resting sell order. Selling base is the safest book-side for randomized tests because
        // every account starts with a large base-token balance and the quote-side math is explicit.
        const id = await placeSpotOrder(
          contracts,
          account,
          tokenAAddress,
          tokenBAddress,
          1,
          price,
          amount,
        );
        openOrders.push({ id, makerIndex: accountIndex });
      } else if (op === 1) {
        const orderSlot = rng.int(openOrders.length);
        const order = openOrders[orderSlot];
        if (order.makerIndex !== counterpartyIndex) {
          await maybeAcceptSpotOrder(contracts, counterparty, order.id, rng.bool() ? amount : amount / 2n);
        }
        const after = await contracts.tokenSpotOrderBook.getOrder(order.id);
        if (after.user === ethers.ZeroAddress || after.amount === 0n) openOrders.splice(orderSlot, 1);
      } else if (op === 2) {
        const orderSlot = rng.int(openOrders.length);
        const order = openOrders[orderSlot];
        await maybeCancelSpotOrder(contracts, accounts[order.makerIndex], order.id);
        openOrders.splice(orderSlot, 1);
      } else if (op === 3) {
        await maybeWithdrawToken(contracts.vault, account, tokenAAddress, ONE / 2n);
        await maybeWithdrawToken(contracts.vault, account, tokenBAddress, ONE / 3n);
      } else {
        await maybeWithdrawEth(contracts.vault, account, ONE / 20n);
      }

      if (step % 3 === 0) {
        await assertAllInvariants(contracts.vault, contracts.accountRegistry, [tokenA, tokenB], accounts);
      }
    }

    for (const order of [...openOrders]) {
      await maybeCancelSpotOrder(contracts, accounts[order.makerIndex], order.id);
    }

    await assertAllInvariants(contracts.vault, contracts.accountRegistry, [tokenA, tokenB], accounts);

    let totalA = 0n;
    let totalB = 0n;
    for (const account of accounts) {
      totalA += await contracts.vault.erc20Balances(account.address, tokenAAddress);
      totalB += await contracts.vault.erc20Balances(account.address, tokenBAddress);
    }

    expect(totalA, "known-account base-token accounting remains positive").to.be.gt(0n);
    expect(totalB, "known-account quote-token accounting remains positive").to.be.gt(0n);
  });
});
