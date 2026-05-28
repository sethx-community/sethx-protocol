import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { createLendingAccount, createNormalAccount } from "../helpers/accounts.js";
import { deployMockAssets, mintMockBalances } from "../helpers/mock-assets.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount)).wait();
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

function lendingMarketKey(expiry: bigint, riskLevel = 1): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint64", "uint16"],
      [ETH, expiry, riskLevel],
    ),
  );
}

async function nextOptionExpiry(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  const now = BigInt(block.timestamp);
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

async function assertVaultEthInvariant(vault: any, accounts: string[]) {
  for (const account of accounts) {
    const total = await vault.ethBalances(account);
    const locked = await vault.ethLocked(account);
    expect(locked, `locked <= total for ${account}`).to.be.lte(total);
  }
}

describe("Full protocol smoke regression", function () {
  it("runs one deterministic cross-subsystem path and finishes with custody invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.dave.getAddress(),
    ]);

    const alice = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const bob = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);
    const carolLending = await createLendingAccount(ethers, contracts.lendingAccountFactory, contracts.accountRegistry, actors.carol);

    const aliceAddress = await alice.getAddress();
    const bobAddress = await bob.getAddress();
    const carolAddress = await carolLending.getAddress();
    const tokenA = await assets.tokenA.getAddress();
    const tokenB = await assets.tokenB.getAddress();

    await depositToken(assets.tokenA, alice, actors.alice, ethers.parseEther("20"));
    await depositToken(assets.tokenB, bob, actors.bob, ethers.parseEther("25"));
    await depositEth(alice, actors.alice, ethers.parseEther("5"));
    await depositEth(bob, actors.bob, ethers.parseEther("5"));
    await depositEth(carolLending, actors.carol, ethers.parseEther("5"));

    const spotOrder = await contracts.tokenSpotOrderBook.nextOrderId();
    await (await alice.connect(actors.alice).placeOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), ETH, tokenA, tokenB, 1, ONE, ethers.parseEther("5"), 0)).wait();
    await (await bob.connect(actors.bob).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), spotOrder, ethers.parseEther("5"), ETH)).wait();
    expect(await contracts.vault.erc20Balances(bobAddress, tokenA)).to.equal(ethers.parseEther("5"));

    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const lendExpiry = await nextOptionExpiry();
    const orderExpiry = now + 3_600n;
    const principal = ethers.parseEther("0.2");
    await (await alice.connect(actors.alice).placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendExpiry, 1, 1_000n, principal, orderExpiry)).wait();
    await (await carolLending.connect(actors.carol).placeBorrowOrder(await contracts.lendingOrderBook.getAddress(), ETH, lendExpiry, 1, principal, 1_000n, orderExpiry)).wait();
    const debt = await contracts.lendingContract.getDebt(carolAddress, lendingMarketKey(lendExpiry, 1));
    expect(debt.principal, "borrower debt principal after smoke borrow").to.equal(principal);

    await assertVaultEthInvariant(contracts.vault, [aliceAddress, bobAddress, carolAddress]);
    expect(await contracts.accountRegistry.isAccount(aliceAddress)).to.equal(true);
    expect(await contracts.accountRegistry.isAccount(bobAddress)).to.equal(true);
    expect(await contracts.accountRegistry.isLendingAccount(carolAddress)).to.equal(true);
  });
});
