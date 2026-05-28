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
import { expectRevert } from "../helpers/reverts.js";

const { ethers } = await network.create();

describe("Security baseline - access control and account boundary", function () {
  it("prepares actors, mock assets, and both account types", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.bob.getAddress(),
      await actors.carol.getAddress(),
      await actors.attacker.getAddress(),
    ]);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const bobLendingAccount = await createLendingAccount(
      ethers,
      contracts.lendingAccountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    expect(await aliceAccount.owner()).to.equal(
      await actors.alice.getAddress(),
    );

    expect(await bobLendingAccount.owner()).to.equal(
      await actors.bob.getAddress(),
    );
  });

  it("rejects direct EOA vault account-only calls", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    await expectRevert(
      contracts.vault
        .connect(actors.attacker)
        .depositETH({ value: ethers.parseEther("1") }),
    );

    await expectRevert(
      contracts.vault
        .connect(actors.attacker)
        .withdrawETHTo(
          await actors.attacker.getAddress(),
          ethers.parseEther("1"),
        ),
    );
  });

  it("rejects unregistered fake account vault calls", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);

    const fakeAccount = await ethers.deployContract("FakeAccount");
    await fakeAccount.waitForDeployment();

    const data = contracts.vault.interface.encodeFunctionData("depositETH", []);

    await expectRevert(
      fakeAccount.callTarget(
        await contracts.vault.getAddress(),
        data,
        ethers.parseEther("1"),
        { value: ethers.parseEther("1") },
      ),
    );
  });

  it("rejects direct EOA orderbook calls", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const attacker = actors.attacker;

    await expectRevert(
      contracts.tokenSpotOrderBook.connect(attacker).cancelOrder(1),
    );

    await expectRevert(
      contracts.nftSpotOrderBook.connect(attacker).cancelOrder(1),
    );

    await expectRevert(
      contracts.futuresOrderBook.connect(attacker).cancelOrder(1),
    );

    await expectRevert(
      contracts.lendingOrderBook.connect(attacker).cancelOrder(1),
    );
  });

  it("rejects unauthorized registry factory operations", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const attackerAddress = await actors.attacker.getAddress();

    await expectRevert(
      contracts.accountRegistry
        .connect(actors.attacker)
        .registerAccount(attackerAddress, attackerAddress),
    );

    await expectRevert(
      contracts.accountRegistry
        .connect(actors.attacker)
        .registerLendingAccount(attackerAddress, attackerAddress),
    );
  });
});
