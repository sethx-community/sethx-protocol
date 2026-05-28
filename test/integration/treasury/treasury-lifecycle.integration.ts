import { expect } from "chai";
import { network } from "hardhat";

import {
  readLocalDeployment,
  requireLocalAddress,
} from "../../helpers/deployment-reader.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;

async function loadTreasuryDeployment() {
  const deployment = readLocalDeployment();

  const addresses = {
    sethxTimelock: requireLocalAddress(deployment, "sethxTimelock"),
    protocolTreasury: requireLocalAddress(deployment, "protocolTreasury"),
    treasuryAuthority: requireLocalAddress(deployment, "treasuryAuthority"),
    treasuryPaymentsModule: requireLocalAddress(
      deployment,
      "treasuryPaymentsModule",
    ),
    treasuryVaultModule: requireLocalAddress(deployment, "treasuryVaultModule"),
    treasuryTradeModule: requireLocalAddress(deployment, "treasuryTradeModule"),
    accountRegistry: requireLocalAddress(deployment, "accountRegistry"),
    accountFactory: requireLocalAddress(deployment, "accountFactory"),
    vault: requireLocalAddress(deployment, "sethxVault"),
    tokenSpotOrderBook: requireLocalAddress(deployment, "tokenSpotOrderBook"),
  };

  const contracts = {
    protocolTreasury: await ethers.getContractAt(
      "ProtocolTreasury",
      addresses.protocolTreasury,
    ),
    treasuryAuthority: await ethers.getContractAt(
      "TreasuryAuthority",
      addresses.treasuryAuthority,
    ),
    treasuryPaymentsModule: await ethers.getContractAt(
      "TreasuryPaymentsModule",
      addresses.treasuryPaymentsModule,
    ),
    treasuryVaultModule: await ethers.getContractAt(
      "TreasuryVaultModule",
      addresses.treasuryVaultModule,
    ),
    treasuryTradeModule: await ethers.getContractAt(
      "TreasuryTradeModule",
      addresses.treasuryTradeModule,
    ),
    accountRegistry: await ethers.getContractAt(
      "AccountRegistry",
      addresses.accountRegistry,
    ),
    accountFactory: await ethers.getContractAt(
      "AccountFactory",
      addresses.accountFactory,
    ),
    vault: await ethers.getContractAt("SethxVault", addresses.vault),
    tokenSpotOrderBook: await ethers.getContractAt(
      "TokenSpotOrderBook",
      addresses.tokenSpotOrderBook,
    ),
  };

  return { deployment, addresses, contracts };
}

async function loadActors() {
  const signers = await ethers.getSigners();
  return {
    deployer: signers[0],
    treasurer: signers[0],
    alice: signers[1],
    bob: signers[2],
    recipient: signers[3],
    attacker: signers[6],
  };
}

async function deployMockToken(name = "Treasury Test Token", symbol = "TTT") {
  const token = await ethers.deployContract("MockERC20", [name, symbol, 18]);
  await token.waitForDeployment();
  return token;
}

async function govern(addresses: any) {
  return impersonateTimelock(ethers, addresses.sethxTimelock);
}

async function expectBlocked(label: string, action: () => Promise<unknown>) {
  let blocked = false;
  try {
    await action();
  } catch (_err) {
    blocked = true;
  }
  expect(blocked, label).to.equal(true);
}

async function ensureTreasurerOperational(authority: any, timelock: any, treasurer: string) {
  const allPermissions =
    (await authority.PERMISSION_CALL_VAULT()) |
    (await authority.PERMISSION_MANAGE_LIQUIDITY()) |
    (await authority.PERMISSION_MANAGE_PAYMENTS()) |
    (await authority.PERMISSION_TRADE_SETHX()) |
    (await authority.PERMISSION_PUBLISH_PASSIVE_QUOTES()) |
    (await authority.PERMISSION_MANAGE_ORACLE_FUNDING());

  if (!(await authority.isTreasurer(treasurer))) {
    await (
      await authority
        .connect(timelock)
        .appointTreasurer(treasurer, "integration treasury operator", allPermissions)
    ).wait();
  } else {
    await (
      await authority
        .connect(timelock)
        .setTreasurerPermissions(treasurer, allPermissions)
    ).wait();
  }

  if (await authority.killed()) {
    await (await authority.connect(timelock).unkillTreasury()).wait();
  }

  const info = await authority.getTreasurerInfo(treasurer);
  if (await authority.frozenTreasurers(treasurer)) {
    await (await authority.connect(timelock).unfreezeTreasurer(treasurer)).wait();
  }

  expect(info.active, "treasurer is active").to.equal(true);
}

async function approveTreasuryPaymentPath(
  contracts: any,
  timelock: any,
  recipient: string,
  token: string,
  monthlyLimit: bigint,
) {
  if (token !== ETH && !(await contracts.protocolTreasury.approvedTokens(token))) {
    await (
      await contracts.protocolTreasury.connect(timelock).setApprovedToken(token, true)
    ).wait();
  }

  if (!(await contracts.protocolTreasury.approvedExternalRecipients(recipient))) {
    await (
      await contracts.protocolTreasury
        .connect(timelock)
        .setApprovedExternalRecipient(recipient, true)
    ).wait();
  }

  await (
    await contracts.treasuryPaymentsModule
      .connect(timelock)
      .setPaymentBudget(recipient, token, monthlyLimit, true)
  ).wait();
  await (
    await contracts.treasuryPaymentsModule
      .connect(timelock)
      .resetPaymentBudgetPeriod(recipient, token)
  ).wait();
}

describe("Treasury operational lifecycle integration", function () {
  it("rejects malicious direct calls to treasury authority, treasury custody, payment, trade, and vault-module surfaces", async function () {
    const { addresses, contracts } = await loadTreasuryDeployment();
    const actors = await loadActors();

    const attackerAddress = await actors.attacker.getAddress();
    const recipientAddress = await actors.recipient.getAddress();
    const treasurerAddress = await actors.treasurer.getAddress();

    await expectBlocked("attacker cannot appoint treasurer", () =>
      contracts.treasuryAuthority
        .connect(actors.attacker)
        .appointTreasurer(attackerAddress, "evil", 1n),
    );
    await expectBlocked("attacker cannot revoke treasurer", () =>
      contracts.treasuryAuthority
        .connect(actors.attacker)
        .revokeTreasurer(treasurerAddress),
    );
    await expectBlocked("attacker cannot freeze treasurer", () =>
      contracts.treasuryAuthority
        .connect(actors.attacker)
        .freezeTreasurer(treasurerAddress),
    );
    await expectBlocked("attacker cannot kill treasury", () =>
      contracts.treasuryAuthority.connect(actors.attacker).killTreasury(),
    );
    await expectBlocked("attacker cannot set guardian", () =>
      contracts.treasuryAuthority
        .connect(actors.attacker)
        .setGuardian(attackerAddress, true),
    );

    await expectBlocked("attacker cannot approve external recipient", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .setApprovedExternalRecipient(recipientAddress, true),
    );
    await expectBlocked("attacker cannot approve internal receiver", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .setApprovedInternalReceiver(attackerAddress, true),
    );
    await expectBlocked("attacker cannot approve token", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .setApprovedToken(attackerAddress, true),
    );
    await expectBlocked("attacker cannot approve module", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .setApprovedTreasuryModule(attackerAddress, true),
    );
    await expectBlocked("attacker cannot directly pull internal ETH", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .fundInternalETH(payable(attackerAddress), 1n),
    );
    await expectBlocked("attacker cannot directly pay ETH", () =>
      contracts.protocolTreasury
        .connect(actors.attacker)
        .payETH(payable(recipientAddress), 1n),
    );

    await expectBlocked("attacker cannot set payment budget", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.attacker)
        .setPaymentBudget(recipientAddress, ETH, ONE, true),
    );
    await expectBlocked("attacker cannot execute payment", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.attacker)
        .payETH(payable(recipientAddress), 1n, "evil"),
    );

    await expectBlocked("attacker cannot open treasury account", () =>
      contracts.treasuryTradeModule.connect(actors.attacker).openTreasuryAccount(),
    );
    await expectBlocked("attacker cannot set trade action permissions", () =>
      contracts.treasuryTradeModule
        .connect(actors.attacker)
        .setTreasurerActionPermissions(attackerAddress, 1n),
    );
    await expectBlocked("attacker cannot approve passive pool", () =>
      contracts.treasuryTradeModule
        .connect(actors.attacker)
        .setApprovedPassivePool(attackerAddress, true),
    );
    await expectBlocked("attacker cannot fund arbitrary account", () =>
      contracts.treasuryTradeModule
        .connect(actors.attacker)
        .depositETHToAccount(attackerAddress, 1n),
    );

    await expectBlocked("attacker cannot pull vault treasury ETH", () =>
      contracts.treasuryVaultModule
        .connect(actors.attacker)
        .pullTreasuryETHFromVault(1n),
    );

    expect(
      await contracts.protocolTreasury.approvedTreasuryModules(
        addresses.treasuryPaymentsModule,
      ),
      "payments module remains approved",
    ).to.equal(true);
  });

  it("executes ETH and ERC20 payments only for approved recipients/tokens within budget, then enforces freeze and kill switches", async function () {
    const { addresses, contracts } = await loadTreasuryDeployment();
    const actors = await loadActors();
    const timelock = await govern(addresses);

    const treasurerAddress = await actors.treasurer.getAddress();
    const recipientAddress = await actors.recipient.getAddress();
    const attackerAddress = await actors.attacker.getAddress();

    await ensureTreasurerOperational(contracts.treasuryAuthority, timelock, treasurerAddress);

    const ethBudget = 5n * ONE;
    const ethPayment = 2n * ONE;

    await approveTreasuryPaymentPath(
      contracts,
      timelock,
      recipientAddress,
      ETH,
      ethBudget,
    );

    await actors.deployer.sendTransaction({
      to: addresses.protocolTreasury,
      value: 10n * ONE,
    });

    const treasuryEthBefore = await ethers.provider.getBalance(addresses.protocolTreasury);
    const recipientEthBefore = await ethers.provider.getBalance(recipientAddress);

    await (
      await contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(recipientAddress), ethPayment, "integration ETH payment")
    ).wait();

    expect(
      await ethers.provider.getBalance(addresses.protocolTreasury),
      "protocol treasury ETH decreased by payment",
    ).to.equal(treasuryEthBefore - ethPayment);
    expect(
      await ethers.provider.getBalance(recipientAddress),
      "recipient ETH increased by payment",
    ).to.equal(recipientEthBefore + ethPayment);

    let budget = await contracts.treasuryPaymentsModule.paymentBudgets(
      recipientAddress,
      ETH,
    );
    expect(budget.spentInPeriod, "ETH budget spent").to.equal(ethPayment);

    await expectBlocked("payment over monthly budget reverts", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(recipientAddress), ethBudget, "too much"),
    );
    await expectBlocked("empty payment memo reverts", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(recipientAddress), 1n, ""),
    );
    await expectBlocked("unapproved recipient payment reverts", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(attackerAddress), 1n, "unapproved"),
    );

    const token = await deployMockToken();
    const tokenAddress = await token.getAddress();
    await (await token.mint(addresses.protocolTreasury, 100n * ONE)).wait();

    await approveTreasuryPaymentPath(
      contracts,
      timelock,
      recipientAddress,
      tokenAddress,
      50n * ONE,
    );

    await (
      await contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payERC20(tokenAddress, recipientAddress, 7n * ONE, "integration ERC20 payment")
    ).wait();

    expect(await token.balanceOf(recipientAddress), "recipient ERC20 paid").to.equal(
      7n * ONE,
    );
    expect(await token.balanceOf(addresses.protocolTreasury), "treasury ERC20 debited").to.equal(
      93n * ONE,
    );

    await (await contracts.treasuryAuthority.connect(timelock).freezeTreasurer(treasurerAddress)).wait();
    expect(await contracts.treasuryAuthority.frozenTreasurers(treasurerAddress)).to.equal(true);
    await expectBlocked("frozen treasurer cannot pay", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(recipientAddress), 1n, "frozen"),
    );
    await (await contracts.treasuryAuthority.connect(timelock).unfreezeTreasurer(treasurerAddress)).wait();

    await (await contracts.treasuryAuthority.connect(timelock).killTreasury()).wait();
    expect(await contracts.treasuryAuthority.killed()).to.equal(true);
    await expectBlocked("killed treasury blocks payment execution", () =>
      contracts.treasuryPaymentsModule
        .connect(actors.treasurer)
        .payETH(payable(recipientAddress), 1n, "killed"),
    );
    await (await contracts.treasuryAuthority.connect(timelock).unkillTreasury()).wait();
    expect(await contracts.treasuryAuthority.killed()).to.equal(false);
  });

  it("opens a treasury account and funds/withdraws ETH and ERC20 only through approved treasurer account access", async function () {
    const { addresses, contracts } = await loadTreasuryDeployment();
    const actors = await loadActors();
    const timelock = await govern(addresses);

    const treasurerAddress = await actors.treasurer.getAddress();
    const attackerAddress = await actors.attacker.getAddress();

    await ensureTreasurerOperational(contracts.treasuryAuthority, timelock, treasurerAddress);

    const tx = await contracts.treasuryTradeModule.connect(timelock).openTreasuryAccount();
    await tx.wait();
    const treasuryAccount = await contracts.treasuryTradeModule.latestTreasuryAccount();

    expect(await contracts.treasuryTradeModule.isTreasuryAccount(treasuryAccount)).to.equal(true);
    expect(await contracts.accountRegistry.isAccount(treasuryAccount)).to.equal(true);

    const allActions =
      (await contracts.treasuryTradeModule.ACTION_FUND_ACCOUNT()) |
      (await contracts.treasuryTradeModule.ACTION_WITHDRAW_ACCOUNT()) |
      (await contracts.treasuryTradeModule.ACTION_SPOT_TRADE()) |
      (await contracts.treasuryTradeModule.ACTION_LEND()) |
      (await contracts.treasuryTradeModule.ACTION_PASSIVE_LP());

    await (
      await contracts.treasuryTradeModule
        .connect(timelock)
        .setTreasurerActionPermissions(treasurerAddress, allActions)
    ).wait();
    await (
      await contracts.treasuryTradeModule
        .connect(timelock)
        .setTreasurerAccountAccess(treasurerAddress, treasuryAccount, true)
    ).wait();

    await expectBlocked("attacker cannot set treasury account access", () =>
      contracts.treasuryTradeModule
        .connect(actors.attacker)
        .setTreasurerAccountAccess(attackerAddress, treasuryAccount, true),
    );

    await actors.deployer.sendTransaction({
      to: addresses.protocolTreasury,
      value: 20n * ONE,
    });

    const fundEth = 3n * ONE;
    const withdrawEth = 1n * ONE;
    const treasuryEthBefore = await ethers.provider.getBalance(addresses.protocolTreasury);

    await (
      await contracts.treasuryTradeModule
        .connect(actors.treasurer)
        .depositETHToAccount(treasuryAccount, fundEth)
    ).wait();

    expect(await contracts.vault.ethBalances(treasuryAccount), "account ETH funded").to.equal(
      fundEth,
    );
    expect(await ethers.provider.getBalance(addresses.protocolTreasury)).to.equal(
      treasuryEthBefore - fundEth,
    );

    await (
      await contracts.treasuryTradeModule
        .connect(actors.treasurer)
        .withdrawETHFromAccount(treasuryAccount, withdrawEth)
    ).wait();

    expect(await contracts.vault.ethBalances(treasuryAccount), "account ETH after withdrawal").to.equal(
      fundEth - withdrawEth,
    );
    expect(await ethers.provider.getBalance(addresses.protocolTreasury)).to.equal(
      treasuryEthBefore - fundEth + withdrawEth,
    );

    const token = await deployMockToken("Treasury Account Token", "TAT");
    const tokenAddress = await token.getAddress();
    await (await token.mint(addresses.protocolTreasury, 100n * ONE)).wait();
    await (
      await contracts.protocolTreasury.connect(timelock).setApprovedToken(tokenAddress, true)
    ).wait();

    await (
      await contracts.treasuryTradeModule
        .connect(actors.treasurer)
        .depositERC20ToAccount(treasuryAccount, tokenAddress, 11n * ONE)
    ).wait();
    expect(
      await contracts.vault.erc20Balances(treasuryAccount, tokenAddress),
      "treasury account ERC20 funded",
    ).to.equal(11n * ONE);
    expect(await token.balanceOf(addresses.protocolTreasury)).to.equal(89n * ONE);

    await (
      await contracts.treasuryTradeModule
        .connect(actors.treasurer)
        .withdrawERC20FromAccount(treasuryAccount, tokenAddress, 4n * ONE)
    ).wait();
    expect(
      await contracts.vault.erc20Balances(treasuryAccount, tokenAddress),
      "treasury account ERC20 after withdrawal",
    ).to.equal(7n * ONE);
    expect(await token.balanceOf(addresses.protocolTreasury)).to.equal(93n * ONE);

    await (
      await contracts.treasuryTradeModule
        .connect(timelock)
        .setTreasurerAccountAccess(treasurerAddress, treasuryAccount, false)
    ).wait();
    await expectBlocked("treasurer cannot fund account after access removed", () =>
      contracts.treasuryTradeModule
        .connect(actors.treasurer)
        .depositETHToAccount(treasuryAccount, 1n),
    );
  });

  it("keeps vault fee pulls fixed to ProtocolTreasury and blocks wrong treasurers or killed/frozen states", async function () {
    const { addresses, contracts } = await loadTreasuryDeployment();
    const actors = await loadActors();
    const timelock = await govern(addresses);

    const treasurerAddress = await actors.treasurer.getAddress();
    await ensureTreasurerOperational(contracts.treasuryAuthority, timelock, treasurerAddress);

    await expectBlocked("attacker cannot pull vault ETH fees", () =>
      contracts.treasuryVaultModule
        .connect(actors.attacker)
        .pullTreasuryETHFromVault(1n),
    );
    await expectBlocked("zero ETH vault pull reverts", () =>
      contracts.treasuryVaultModule
        .connect(actors.treasurer)
        .pullTreasuryETHFromVault(0n),
    );
    await expectBlocked("zero token vault pull reverts", () =>
      contracts.treasuryVaultModule
        .connect(actors.treasurer)
        .pullTreasuryERC20FromVault(ETH, 1n),
    );

    const treasuryEthInVault = await contracts.vault.treasuryEthBalance();
    if (treasuryEthInVault > 0n) {
      const pullAmount = treasuryEthInVault > ONE ? ONE : treasuryEthInVault;
      const protocolBefore = await ethers.provider.getBalance(addresses.protocolTreasury);
      await (
        await contracts.treasuryVaultModule
          .connect(actors.treasurer)
          .pullTreasuryETHFromVault(pullAmount)
      ).wait();
      expect(await ethers.provider.getBalance(addresses.protocolTreasury)).to.equal(
        protocolBefore + pullAmount,
      );
    }

    await (await contracts.treasuryAuthority.connect(timelock).freezeTreasurer(treasurerAddress)).wait();
    await expectBlocked("frozen treasurer cannot pull vault fees", () =>
      contracts.treasuryVaultModule
        .connect(actors.treasurer)
        .pullTreasuryETHFromVault(1n),
    );
    await (await contracts.treasuryAuthority.connect(timelock).unfreezeTreasurer(treasurerAddress)).wait();
  });
});

function payable(address: string): string {
  return address;
}
