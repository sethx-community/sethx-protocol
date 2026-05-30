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

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(days = 7): Promise<bigint> {
  return (await latestTimestamp()) + BigInt(days) * 24n * 60n * 60n;
}

async function depositEth(account: any, owner: any, amount: bigint) {
  const tx = await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount });
  return (await tx.wait())!.gasUsed;
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  const tx = await account.connect(owner).depositToken(await token.getAddress(), amount, await account.getAddress(), await account.vault());
  return (await tx.wait())!.gasUsed;
}

async function expectGasBelow(label: string, actual: bigint, threshold: bigint) {
  expect(actual, `${label} gas ${actual.toString()} <= ${threshold.toString()}`).to.be.lte(threshold);
}

describe("Gas and performance threshold integration", function () {
  it("keeps common account, vault, and token spot operations below local production-readiness thresholds", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
    ]);

    const maker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.alice);
    const taker = await createNormalAccount(ethers, contracts.accountFactory, contracts.accountRegistry, actors.bob);

    const makerAddress = await maker.getAddress();
    const takerAddress = await taker.getAddress();
    const tokenA = await assets.tokenA.getAddress();
    const tokenB = await assets.tokenB.getAddress();

    await expectGasBelow("maker ETH deposit", await depositEth(maker, actors.alice, ONE), 1_500_000n);
    await expectGasBelow("taker ETH deposit", await depositEth(taker, actors.bob, ONE), 1_500_000n);
    await expectGasBelow("maker ERC20 deposit", await depositToken(assets.tokenA, maker, actors.alice, 100n * ONE), 1_500_000n);
    await expectGasBelow("taker ERC20 deposit", await depositToken(assets.tokenB, taker, actors.bob, 1_000n * ONE), 1_500_000n);

    const orderId = await contracts.tokenSpotOrderBook.nextOrderId();
    const placeTx = await maker
      .connect(actors.alice)
      .placeOrderTokenSpot(
        await contracts.tokenSpotOrderBook.getAddress(),
        ETH,
        tokenA,
        tokenB,
        1,
        ONE,
        25n * ONE,
        await freshOrderExpiry(),
      );
    await expectGasBelow("token spot place order", (await placeTx.wait())!.gasUsed, 4_000_000n);

    const acceptTx = await taker
      .connect(actors.bob)
      .acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), orderId, 25n * ONE, ETH);
    await expectGasBelow("token spot full fill", (await acceptTx.wait())!.gasUsed, 7_500_000n);

    for (const account of [makerAddress, takerAddress]) {
      expect(await contracts.vault.ethLocked(account), "ETH locked <= total").to.be.lte(await contracts.vault.ethBalances(account));
      expect(await contracts.vault.erc20Locked(account, tokenA), "tokenA locked <= total").to.be.lte(
        await contracts.vault.erc20Balances(account, tokenA),
      );
      expect(await contracts.vault.erc20Locked(account, tokenB), "tokenB locked <= total").to.be.lte(
        await contracts.vault.erc20Balances(account, tokenB),
      );
    }
  });
});
