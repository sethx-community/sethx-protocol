import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";

import { createNormalAccount } from "../helpers/accounts.js";
import { deployMockAssets } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const REASON = "vault-custody-invariant-test";
const MARKET_A = ethers.id("VAULT_TEST_MARKET_A");

async function expectEthVaultDeltaInvariant(
  vault: any,
  vaultAddress: string,
  baselineVaultBalance: bigint,
  accounts: string[],
  settlementKeys: string[] = [],
) {
  let accountedDelta = 0n;

  for (const account of accounts) {
    const total = await vault.ethBalances(account);
    const locked = await vault.ethLocked(account);

    expect(locked).to.be.lte(total);
    accountedDelta += total;
  }

  for (const marketKey of settlementKeys) {
    accountedDelta += await vault.settlementEthLocked(marketKey);
  }

  expect(await ethers.provider.getBalance(vaultAddress)).to.equal(
    baselineVaultBalance + accountedDelta,
  );
}

async function expectErc20VaultInvariant(
  vault: any,
  token: any,
  tokenAddress: string,
  vaultAddress: string,
  accounts: string[],
  settlementKeys: string[] = [],
) {
  let accounted = await vault.treasuryBalances(tokenAddress);

  for (const account of accounts) {
    const total = await vault.erc20Balances(account, tokenAddress);
    const locked = await vault.erc20Locked(account, tokenAddress);

    expect(locked).to.be.lte(total);
    accounted += total;
  }

  for (const marketKey of settlementKeys) {
    accounted += await vault.settlementErc20Locked(marketKey, tokenAddress);
  }

  expect(await token.balanceOf(vaultAddress)).to.equal(accounted);
}

async function expectAccountEthSplit(
  vault: any,
  account: string,
  expectedTotal: bigint,
  expectedLocked: bigint,
) {
  expect(await vault.ethBalances(account)).to.equal(expectedTotal);
  expect(await vault.ethLocked(account)).to.equal(expectedLocked);

  const split = await vault.getEthBalances(account);
  expect(split.freeEth).to.equal(expectedTotal - expectedLocked);
  expect(split.reservedOrderEth).to.equal(expectedLocked);
}

async function expectAccountErc20Split(
  vault: any,
  account: string,
  token: string,
  expectedTotal: bigint,
  expectedLocked: bigint,
) {
  expect(await vault.erc20Balances(account, token)).to.equal(expectedTotal);
  expect(await vault.erc20Locked(account, token)).to.equal(expectedLocked);

  const balances = await vault.getErc20Balances(account);
  const tokenBalance = balances.find(
    (balance: any) =>
      ethers.getAddress(balance.token) === ethers.getAddress(token),
  );

  if (
    expectedTotal === 0n &&
    expectedLocked === 0n &&
    tokenBalance === undefined
  ) {
    return;
  }

  expect(tokenBalance).to.not.equal(undefined);
  expect(tokenBalance.freeAmount).to.equal(expectedTotal - expectedLocked);
  expect(tokenBalance.reservedOrderAmount).to.equal(expectedLocked);
}

async function expectNftCustody(
  vault: any,
  nft: any,
  vaultAddress: string,
  account: string,
  tokenId: bigint,
  expectedOwned: boolean,
  expectedLocked: boolean,
  expectedOwner: string,
) {
  expect(
    await vault.erc721Owned(account, await nft.getAddress(), tokenId),
  ).to.equal(expectedOwned);
  expect(
    await vault.erc721Locked(account, await nft.getAddress(), tokenId),
  ).to.equal(expectedLocked);
  expect(await nft.ownerOf(tokenId)).to.equal(expectedOwner);

  if (expectedOwner === vaultAddress) {
    expect(expectedOwned).to.equal(true);
  }
}

describe("SethxVault custody and invariant integration", function () {
  it("rejects malicious direct EOA calls to every vault-specific external mutating function", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const attackerAddress = await actors.attacker.getAddress();
    const aliceAddress = await actors.alice.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();
    const nftAddress = await assets.nft.getAddress();

    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        "setOrderbook",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .setOrderbook(attackerAddress, true),
      ],
      [
        "setTreasury",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .setTreasury(attackerAddress, true),
      ],
      [
        "setSettlementManager",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .setSettlementManager(attackerAddress, true),
      ],
      [
        "setProtocolTreasury",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .setProtocolTreasury(attackerAddress),
      ],
      [
        "depositETH",
        () =>
          contracts.vault
        .connect(actors.attacker)
        .depositETH({ value: ethers.parseEther("1") }),
      ],
      [
        "withdrawETHTo",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .withdrawETHTo(attackerAddress, ethers.parseEther("1")),
      ],
      [
        "lockETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .lockETH(aliceAddress, ethers.parseEther("1")),
      ],
      [
        "unlockETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .unlockETH(aliceAddress, ethers.parseEther("1")),
      ],
      [
        "transferETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferETH(
              aliceAddress,
              attackerAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "transferLockedETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferLockedETH(
              aliceAddress,
              attackerAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "collectFreeEthToSettlement",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .collectFreeEthToSettlement(
              MARKET_A,
              aliceAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "transferFreeETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferFreeETH(
              aliceAddress,
              attackerAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "depositERC20",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .depositERC20(tokenAddress, ethers.parseEther("1")),
      ],
      [
        "withdrawERC20To",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .withdrawERC20To(
              tokenAddress,
              attackerAddress,
              ethers.parseEther("1"),
            ),
      ],
      [
        "lockERC20",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .lockERC20(aliceAddress, tokenAddress, ethers.parseEther("1")),
      ],
      [
        "unlockERC20",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .unlockERC20(aliceAddress, tokenAddress, ethers.parseEther("1")),
      ],
      [
        "transferToken",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferToken(
              aliceAddress,
              attackerAddress,
              tokenAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "transferLockedERC20",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferLockedERC20(
              aliceAddress,
              attackerAddress,
              tokenAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "depositERC721",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .depositERC721(nftAddress, 1n),
      ],
      [
        "withdrawERC721To",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .withdrawERC721To(nftAddress, 1n, attackerAddress),
      ],
      [
        "lockERC721",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .lockERC721(aliceAddress, nftAddress, 1n),
      ],
      [
        "unlockERC721",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .unlockERC721(aliceAddress, nftAddress, 1n),
      ],
      [
        "transferERC721",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .transferERC721(
              aliceAddress,
              attackerAddress,
              nftAddress,
              1n,
              REASON,
            ),
      ],
      [
        "chargeFee",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .chargeFee(aliceAddress, ETH, ethers.parseEther("1"), REASON, true),
      ],
      [
        "collectToSettlement",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .collectToSettlement(
              MARKET_A,
              aliceAddress,
              ETH,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "payFromSettlement",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .payFromSettlement(
              MARKET_A,
              attackerAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "payFromFuturesSettlementLocked",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .payFromFuturesSettlementLocked(
              MARKET_A,
              attackerAddress,
              ethers.parseEther("1"),
              REASON,
            ),
      ],
      [
        "withdrawTreasuryETH",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .withdrawTreasuryETH(ethers.parseEther("1")),
      ],
      [
        "withdrawTreasuryERC20",
        () =>
          contracts.vault
            .connect(actors.attacker)
            .withdrawTreasuryERC20(tokenAddress, ethers.parseEther("1")),
      ],
    ];

    for (const [name, call] of calls) {
      try {
        await expectRevert(call());
      } catch (error) {
        throw new Error(`Expected malicious direct call to revert: ${name}`, {
          cause: error,
        });
      }
    }
  });

  it("rejects unregistered fake-account attempts against account-gated vault entry points", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const fakeAccount = await ethers.deployContract("FakeAccount");
    await fakeAccount.waitForDeployment();

    const vaultAddress = await contracts.vault.getAddress();
    const attackerAddress = await actors.attacker.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();
    const nftAddress = await assets.nft.getAddress();

    const fakeCalls: Array<[string, string, bigint]> = [
      [
        "depositETH",
        contracts.vault.interface.encodeFunctionData("depositETH", []),
        ethers.parseEther("1"),
      ],
      [
        "withdrawETHTo",
        contracts.vault.interface.encodeFunctionData("withdrawETHTo", [
          attackerAddress,
          ethers.parseEther("1"),
        ]),
        0n,
      ],
      [
        "depositERC20",
        contracts.vault.interface.encodeFunctionData("depositERC20", [
          tokenAddress,
          ethers.parseEther("1"),
        ]),
        0n,
      ],
      [
        "withdrawERC20To",
        contracts.vault.interface.encodeFunctionData("withdrawERC20To", [
          tokenAddress,
          attackerAddress,
          ethers.parseEther("1"),
        ]),
        0n,
      ],
      [
        "depositERC721",
        contracts.vault.interface.encodeFunctionData("depositERC721", [
          nftAddress,
          1n,
        ]),
        0n,
      ],
      [
        "withdrawERC721To",
        contracts.vault.interface.encodeFunctionData("withdrawERC721To", [
          nftAddress,
          1n,
          attackerAddress,
        ]),
        0n,
      ],
    ];

    for (const [name, data, value] of fakeCalls) {
      try {
        await expectRevert(
          fakeAccount.callTarget(vaultAddress, data, value, { value }),
        );
      } catch (error) {
        throw new Error(`Expected fake-account vault call to revert: ${name}`, {
          cause: error,
        });
      }
    }
  });

  it("tracks account-mediated ETH custody and free/locked invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const aliceAccountAddress = await aliceAccount.getAddress();
    const vaultAddress = await contracts.vault.getAddress();
    const depositAmount = ethers.parseEther("3");
    const withdrawAmount = ethers.parseEther("1.25");
    const baselineVaultBalance = await ethers.provider.getBalance(vaultAddress);

    await expectAccountEthSplit(contracts.vault, aliceAccountAddress, 0n, 0n);

    await (
      await aliceAccount
        .connect(actors.alice)
        .depositETH(await aliceAccount.getAddress(), await aliceAccount.vault(), { value: depositAmount })
    ).wait();

    await expectAccountEthSplit(
      contracts.vault,
      aliceAccountAddress,
      depositAmount,
      0n,
    );
    await expectEthVaultDeltaInvariant(
      contracts.vault,
      vaultAddress,
      baselineVaultBalance,
      [aliceAccountAddress],
    );

    await (
      await aliceAccount.connect(actors.alice).withdrawETH(withdrawAmount)
    ).wait();

    await expectAccountEthSplit(
      contracts.vault,
      aliceAccountAddress,
      depositAmount - withdrawAmount,
      0n,
    );
    await expectEthVaultDeltaInvariant(
      contracts.vault,
      vaultAddress,
      baselineVaultBalance,
      [aliceAccountAddress],
    );

    await expectRevert(aliceAccount.connect(actors.alice).withdrawETH(0n));
    await expectRevert(
      aliceAccount
        .connect(actors.alice)
        .withdrawETH(depositAmount - withdrawAmount + 1n),
    );
  });

  it("tracks account-mediated ERC20 custody and free/locked invariants", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const aliceAddress = await actors.alice.getAddress();
    const aliceAccountAddress = await aliceAccount.getAddress();
    const vaultAddress = await contracts.vault.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();
    const depositAmount = ethers.parseEther("500");
    const withdrawAmount = ethers.parseEther("125");

    await (await assets.tokenA.mint(aliceAddress, depositAmount)).wait();
    await (
      await assets.tokenA
        .connect(actors.alice)
        .approve(aliceAccountAddress, depositAmount)
    ).wait();

    await expectAccountErc20Split(
      contracts.vault,
      aliceAccountAddress,
      tokenAddress,
      0n,
      0n,
    );

    await (
      await aliceAccount
        .connect(actors.alice)
        .depositToken(tokenAddress, depositAmount, await aliceAccount.getAddress(), await aliceAccount.vault())
    ).wait();

    await expectAccountErc20Split(
      contracts.vault,
      aliceAccountAddress,
      tokenAddress,
      depositAmount,
      0n,
    );
    expect(await assets.tokenA.balanceOf(vaultAddress)).to.equal(depositAmount);
    expect(await assets.tokenA.balanceOf(aliceAccountAddress)).to.equal(0n);
    expect(await contracts.vault.isERC20(tokenAddress)).to.equal(true);

    await expectErc20VaultInvariant(
      contracts.vault,
      assets.tokenA,
      tokenAddress,
      vaultAddress,
      [aliceAccountAddress],
    );

    await (
      await aliceAccount
        .connect(actors.alice)
        .withdrawToken(tokenAddress, withdrawAmount)
    ).wait();

    await expectAccountErc20Split(
      contracts.vault,
      aliceAccountAddress,
      tokenAddress,
      depositAmount - withdrawAmount,
      0n,
    );
    expect(await assets.tokenA.balanceOf(aliceAddress)).to.equal(
      withdrawAmount,
    );

    await expectErc20VaultInvariant(
      contracts.vault,
      assets.tokenA,
      tokenAddress,
      vaultAddress,
      [aliceAccountAddress],
    );

    await expectRevert(
      aliceAccount.connect(actors.alice).withdrawToken(tokenAddress, 0n),
    );
    await expectRevert(
      aliceAccount
        .connect(actors.alice)
        .withdrawToken(tokenAddress, depositAmount - withdrawAmount + 1n),
    );
  });

  it("tracks account-mediated ERC721 custody, ownership, and lock flags", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const aliceAddress = await actors.alice.getAddress();
    const aliceAccountAddress = await aliceAccount.getAddress();
    const vaultAddress = await contracts.vault.getAddress();
    const nftAddress = await assets.nft.getAddress();
    const tokenId = 101n;

    await (await assets.nft.mintSpecific(aliceAddress, tokenId)).wait();
    await (
      await assets.nft
        .connect(actors.alice)
        .approve(aliceAccountAddress, tokenId)
    ).wait();

    await (
      await aliceAccount
        .connect(actors.alice)
        .depositNFT721(nftAddress, tokenId, await aliceAccount.getAddress(), await aliceAccount.vault())
    ).wait();

    expect(await contracts.vault.isERC721(nftAddress)).to.equal(true);
    expect(
      await contracts.vault.erc721BalanceCount(aliceAccountAddress, nftAddress),
    ).to.equal(1n);
    await expectNftCustody(
      contracts.vault,
      assets.nft,
      vaultAddress,
      aliceAccountAddress,
      tokenId,
      true,
      false,
      vaultAddress,
    );

    await expectRevert(
      aliceAccount.connect(actors.alice).depositNFT721(nftAddress, tokenId, await aliceAccount.getAddress(), await aliceAccount.vault()),
    );

    await (
      await aliceAccount
        .connect(actors.alice)
        .withdrawNFT721(nftAddress, tokenId)
    ).wait();

    expect(
      await contracts.vault.erc721BalanceCount(aliceAccountAddress, nftAddress),
    ).to.equal(0n);
    expect(
      await contracts.vault.erc721Owned(
        aliceAccountAddress,
        nftAddress,
        tokenId,
      ),
    ).to.equal(false);
    expect(
      await contracts.vault.erc721Locked(
        aliceAccountAddress,
        nftAddress,
        tokenId,
      ),
    ).to.equal(false);
    expect(await assets.nft.ownerOf(tokenId)).to.equal(aliceAddress);

    await expectRevert(
      aliceAccount.connect(actors.alice).withdrawNFT721(nftAddress, tokenId),
    );
  });

  it("rejects invalid account-mediated custody inputs without changing vault state", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const aliceAddress = await actors.alice.getAddress();
    const aliceAccountAddress = await aliceAccount.getAddress();
    const vaultAddress = await contracts.vault.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();
    const nftAddress = await assets.nft.getAddress();
    const baselineVaultBalance = await ethers.provider.getBalance(vaultAddress);

    await expectRevert(
      aliceAccount.connect(actors.alice).depositETH(await aliceAccount.getAddress(), await aliceAccount.vault(), { value: 0n }),
    );
    await expectRevert(
      aliceAccount.connect(actors.alice).depositToken(ETH, 1n, await aliceAccount.getAddress(), await aliceAccount.vault()),
    );
    await expectRevert(
      aliceAccount.connect(actors.alice).depositToken(tokenAddress, 0n, await aliceAccount.getAddress(), await aliceAccount.vault()),
    );
    await expectRevert(
      aliceAccount.connect(actors.alice).depositNFT721(ETH, 1n, await aliceAccount.getAddress(), await aliceAccount.vault()),
    );

    await expectAccountEthSplit(contracts.vault, aliceAccountAddress, 0n, 0n);
    await expectAccountErc20Split(
      contracts.vault,
      aliceAccountAddress,
      tokenAddress,
      0n,
      0n,
    );
    expect(
      await contracts.vault.erc721BalanceCount(aliceAccountAddress, nftAddress),
    ).to.equal(0n);
    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(
      baselineVaultBalance,
    );
    await expectErc20VaultInvariant(
      contracts.vault,
      assets.tokenA,
      tokenAddress,
      vaultAddress,
      [aliceAccountAddress],
    );

    expect(await ethers.provider.getBalance(aliceAccountAddress)).to.equal(0n);
    expect(await assets.tokenA.balanceOf(aliceAddress)).to.equal(0n);
  });

  it("documents deferred positive coverage for role-gated vault operations", async function () {
    const roleGatedVaultFunctions = [
      "setOrderbook",
      "setTreasury",
      "setSettlementManager",
      "setProtocolTreasury",
      "lockETH",
      "unlockETH",
      "transferETH",
      "transferLockedETH",
      "collectFreeEthToSettlement",
      "transferFreeETH",
      "lockERC20",
      "unlockERC20",
      "transferToken",
      "transferLockedERC20",
      "lockERC721",
      "unlockERC721",
      "transferERC721",
      "chargeFee",
      "collectToSettlement",
      "payFromSettlement",
      "payFromFuturesSettlementLocked",
      "withdrawTreasuryETH",
      "withdrawTreasuryERC20",
    ];

    const deferredPositiveCoverage = {
      governance: [
        "setOrderbook",
        "setTreasury",
        "setSettlementManager",
        "setProtocolTreasury",
      ],
      marketLifecycles: [
        "lockETH",
        "unlockETH",
        "transferETH",
        "transferLockedETH",
        "lockERC20",
        "unlockERC20",
        "transferToken",
        "transferLockedERC20",
        "lockERC721",
        "unlockERC721",
        "transferERC721",
        "chargeFee",
      ],
      settlementLifecycles: [
        "collectFreeEthToSettlement",
        "transferFreeETH",
        "collectToSettlement",
        "payFromSettlement",
        "payFromFuturesSettlementLocked",
      ],
      treasuryLifecycles: ["withdrawTreasuryETH", "withdrawTreasuryERC20"],
    };

    const deferred = Object.values(deferredPositiveCoverage).flat();
    expect(new Set(deferred).size).to.equal(roleGatedVaultFunctions.length);

    for (const functionName of roleGatedVaultFunctions) {
      expect(deferred).to.include(functionName);
    }
  });
});
