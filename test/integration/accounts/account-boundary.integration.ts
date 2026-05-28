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

describe("Account boundary integration", function () {
  it("creates a normal Account through AccountFactory and registers it correctly", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const aliceAddress = await actors.alice.getAddress();

    const account = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const accountAddress = await account.getAddress();

    expect(await account.owner()).to.equal(aliceAddress);
    expect(await account.vault()).to.equal(addresses.sethxVault);

    expect(
      await contracts.accountRegistry.ownerOfAccount(accountAddress),
    ).to.equal(aliceAddress);

    expect(await contracts.accountRegistry.isAccount(accountAddress)).to.equal(
      true,
    );

    expect(
      await contracts.accountRegistry.isLendingAccount(accountAddress),
    ).to.equal(false);
  });

  it("creates a LendingAccount through LendingAccountFactory and registers it correctly", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const bobAddress = await actors.bob.getAddress();

    const lendingAccount = await createLendingAccount(
      ethers,
      contracts.lendingAccountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const lendingAccountAddress = await lendingAccount.getAddress();

    expect(await lendingAccount.owner()).to.equal(bobAddress);
    expect(await lendingAccount.vault()).to.equal(addresses.sethxVault);
    expect(await lendingAccount.lendingContract()).to.equal(
      addresses.lendingContract,
    );
    expect(await lendingAccount.riskModule()).to.equal(addresses.riskModule);
    expect(await lendingAccount.liquidationEngine()).to.equal(
      addresses.liquidationEngine,
    );

    expect(
      await contracts.accountRegistry.ownerOfAccount(lendingAccountAddress),
    ).to.equal(bobAddress);

    expect(
      await contracts.accountRegistry.isAccount(lendingAccountAddress),
    ).to.equal(false);

    expect(
      await contracts.accountRegistry.isLendingAccount(lendingAccountAddress),
    ).to.equal(true);
  });

  it("creates new LendingAccounts with Timelock as account governor after final handoff", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const lendingAccount = await createLendingAccount(
      ethers,
      contracts.lendingAccountFactory,
      contracts.accountRegistry,
      actors.carol,
    );

    expect(await contracts.lendingAccountFactory.accountGovernor()).to.equal(
      addresses.sethxTimelock,
    );

    expect(await lendingAccount.governor()).to.equal(addresses.sethxTimelock);
  });

  it("rejects registry writes from unauthorized users", async function () {
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

    await expectRevert(
      contracts.accountRegistry
        .connect(actors.attacker)
        .transferAccountOwner(attackerAddress, attackerAddress),
    );
  });

  it("rejects direct admin role escalation attempts", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const attackerAddress = await actors.attacker.getAddress();

    await expectRevert(
      contracts.accountRegistry
        .connect(actors.attacker)
        .grantRole(ethers.ZeroHash, attackerAddress),
    );
  });

  it("enforces Account owner-only wrappers", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.alice.getAddress(),
      await actors.attacker.getAddress(),
    ]);

    const aliceAddress = await actors.alice.getAddress();

    await expectRevert(aliceAccount.connect(actors.attacker).withdrawETH(1n));

    await expectRevert(
      aliceAccount
        .connect(actors.attacker)
        .withdrawToken(await assets.tokenA.getAddress(), 1n),
    );

    await expectRevert(
      aliceAccount
        .connect(actors.attacker)
        .withdrawNFT721(await assets.nft.getAddress(), 1n),
    );

    expect(await aliceAccount.owner()).to.equal(aliceAddress);
  });

  it("enforces LendingAccount owner-only wrappers", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const lendingAccount = await createLendingAccount(
      ethers,
      contracts.lendingAccountFactory,
      contracts.accountRegistry,
      actors.bob,
    );

    const assets = await deployMockAssets(ethers);

    await mintMockBalances(ethers, assets, [
      await actors.bob.getAddress(),
      await actors.attacker.getAddress(),
    ]);

    await expectRevert(lendingAccount.connect(actors.attacker).withdrawETH(1n));

    await expectRevert(
      lendingAccount
        .connect(actors.attacker)
        .withdrawToken(await assets.tokenA.getAddress(), 1n),
    );

    await expectRevert(
      lendingAccount
        .connect(actors.attacker)
        .withdrawNFT721(await assets.nft.getAddress(), 1n),
    );

    await expectRevert(
      lendingAccount
        .connect(actors.attacker)
        .placeBorrowOrder(
          await contracts.lendingOrderBook.getAddress(),
          ethers.ZeroAddress,
          0,
          1,
          1n,
          1n,
        ),
    );
  });

  it("rejects unregistered fake account vault access", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);

    const fakeAccount = await ethers.deployContract("FakeAccount");
    await fakeAccount.waitForDeployment();

    const depositData = contracts.vault.interface.encodeFunctionData(
      "depositETH",
      [],
    );

    await expectRevert(
      fakeAccount.callTarget(
        await contracts.vault.getAddress(),
        depositData,
        ethers.parseEther("1"),
        { value: ethers.parseEther("1") },
      ),
    );
  });

  it("normal Account has no direct borrow surface", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const aliceAccount = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.alice,
    );

    expect(typeof (aliceAccount as any).borrowFromOrderBook).to.equal(
      "undefined",
    );
    expect(typeof (aliceAccount as any).repayBorrow).to.equal("undefined");
  });

  it("LendingAccountFactory rejects invalid governor-controlled configuration from non-governor", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    await expectRevert(
      contracts.lendingAccountFactory
        .connect(actors.attacker)
        .setLendingContract(await contracts.lendingContract.getAddress()),
    );

    await expectRevert(
      contracts.lendingAccountFactory
        .connect(actors.attacker)
        .setRiskModule(await contracts.riskModule.getAddress()),
    );

    await expectRevert(
      contracts.lendingAccountFactory
        .connect(actors.attacker)
        .setLiquidationEngine(await contracts.liquidationEngine.getAddress()),
    );

    await expectRevert(
      contracts.lendingAccountFactory
        .connect(actors.attacker)
        .setAccountGovernor(await actors.attacker.getAddress()),
    );
  });
});
