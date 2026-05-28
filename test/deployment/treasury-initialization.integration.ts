import { expect } from "chai";
import { network } from "hardhat";

import { INITIAL_PROTOCOL_PARAMETERS } from "../../scripts/parameters/initial-protocol-parameters.js";
import {
  readLocalDeployment,
  requireLocalAddress,
} from "../helpers/deployment-reader.js";

const { ethers } = await network.create();

function resolveToken(token: string, sethxToken: string): string {
  if (token === "ETH") return ethers.ZeroAddress;
  if (token === "SETHX") return sethxToken;
  if (token.startsWith("0x") && token.length === 42) return token;

  throw new Error(`Unsupported token reference: ${token}`);
}

describe("Final treasury initialization", function () {
  async function loadDeployment() {
    const deployment = readLocalDeployment();

    const addresses = {
      sethxToken: requireLocalAddress(deployment, "sethxToken"),
      accountRegistry: requireLocalAddress(deployment, "accountRegistry"),
      sethxVault: requireLocalAddress(deployment, "sethxVault"),
      protocolTreasury: requireLocalAddress(deployment, "protocolTreasury"),
      treasuryAuthority: requireLocalAddress(deployment, "treasuryAuthority"),
      treasuryPaymentsModule: requireLocalAddress(
        deployment,
        "treasuryPaymentsModule",
      ),
      treasuryVaultModule: requireLocalAddress(deployment, "treasuryVaultModule"),
      treasuryTradeModule: requireLocalAddress(deployment, "treasuryTradeModule"),
    };

    const accountRegistry = await ethers.getContractAt(
      "AccountRegistry",
      addresses.accountRegistry,
    );
    const vault = await ethers.getContractAt("SethxVault", addresses.sethxVault);
    const protocolTreasury = await ethers.getContractAt(
      "ProtocolTreasury",
      addresses.protocolTreasury,
    );
    const treasuryAuthority = await ethers.getContractAt(
      "TreasuryAuthority",
      addresses.treasuryAuthority,
    );
    const treasuryPaymentsModule = await ethers.getContractAt(
      "TreasuryPaymentsModule",
      addresses.treasuryPaymentsModule,
    );
    const treasuryTradeModule = await ethers.getContractAt(
      "TreasuryTradeModule",
      addresses.treasuryTradeModule,
    );

    return {
      addresses,
      accountRegistry,
      vault,
      protocolTreasury,
      treasuryAuthority,
      treasuryPaymentsModule,
      treasuryTradeModule,
    };
  }

  it("authorizes treasury modules and protocol receivers", async function () {
    const { addresses, accountRegistry, vault, protocolTreasury } =
      await loadDeployment();

    const factoryRole = await accountRegistry.FACTORY_ROLE();
    const treasuryRole = await vault.TREASURY_ROLE();

    expect(
      await accountRegistry.hasRole(factoryRole, addresses.treasuryTradeModule),
    ).to.equal(true);

    expect(await vault.hasRole(treasuryRole, addresses.treasuryVaultModule)).to.equal(
      true,
    );

    expect(
      await protocolTreasury.approvedTreasuryModules(
        addresses.treasuryPaymentsModule,
      ),
    ).to.equal(true);

    expect(
      await protocolTreasury.approvedTreasuryModules(addresses.treasuryTradeModule),
    ).to.equal(true);

    expect(
      await protocolTreasury.approvedInternalReceivers(
        addresses.treasuryTradeModule,
      ),
    ).to.equal(true);
  });

  it("initializes the treasurer and guardian from parameters", async function () {
    const { treasuryAuthority } = await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.treasury;

    const treasurer = params.initialTreasurer;
    const guardian = params.initialGuardian || params.initialTreasurer;

    expect(await treasuryAuthority.isTreasurer(treasurer)).to.equal(true);

    const guardianRole = await treasuryAuthority.GUARDIAN_ROLE();
    expect(await treasuryAuthority.hasRole(guardianRole, guardian)).to.equal(true);
  });

  it("assigns configured treasury permissions and trade module actions", async function () {
    const { treasuryAuthority, treasuryTradeModule } = await loadDeployment();

    const treasurer = INITIAL_PROTOCOL_PARAMETERS.treasury.initialTreasurer;

    const expectedPermissions =
      (await treasuryAuthority.PERMISSION_CALL_VAULT()) |
      (await treasuryAuthority.PERMISSION_MANAGE_LIQUIDITY()) |
      (await treasuryAuthority.PERMISSION_MANAGE_PAYMENTS()) |
      (await treasuryAuthority.PERMISSION_TRADE_SETHX()) |
      (await treasuryAuthority.PERMISSION_PUBLISH_PASSIVE_QUOTES()) |
      (await treasuryAuthority.PERMISSION_MANAGE_ORACLE_FUNDING());

    expect(await treasuryAuthority.getTreasurerPermissions(treasurer)).to.equal(
      expectedPermissions,
    );

    const expectedActions =
      (await treasuryTradeModule.ACTION_FUND_ACCOUNT()) |
      (await treasuryTradeModule.ACTION_WITHDRAW_ACCOUNT()) |
      (await treasuryTradeModule.ACTION_SPOT_TRADE()) |
      (await treasuryTradeModule.ACTION_LEND()) |
      (await treasuryTradeModule.ACTION_PASSIVE_LP());

    expect(await treasuryTradeModule.treasurerActionPermissions(treasurer)).to.equal(
      expectedActions,
    );
  });

  it("initializes external payment recipients and budgets", async function () {
    const { addresses, protocolTreasury, treasuryPaymentsModule } =
      await loadDeployment();

    for (const recipientConfig of INITIAL_PROTOCOL_PARAMETERS.treasury
      .paymentRecipients) {
      const token = resolveToken(recipientConfig.token, addresses.sethxToken);

      expect(
        await protocolTreasury.approvedExternalRecipients(
          recipientConfig.recipient,
        ),
      ).to.equal(recipientConfig.approved);

      const budget = await treasuryPaymentsModule.paymentBudgets(
        recipientConfig.recipient,
        token,
      );

      const approved = budget.approved ?? budget[0];
      const monthlyLimit =
        budget.monthlyLimit ??
        budget.maxAmountPerMonth ??
        budget.monthlyAmount ??
        budget[1];
      const spentThisWindow =
        budget.spentThisWindow ??
        budget.spentThisMonth ??
        budget.spentInWindow ??
        budget[2];

      expect(approved).to.equal(recipientConfig.approved);
      expect(monthlyLimit).to.equal(recipientConfig.monthlyLimit);
      expect(spentThisWindow).to.equal(0n);
    }
  });

  it("does not require ProtocolTreasury token approval for ETH payment budgets", async function () {
    const { protocolTreasury } = await loadDeployment();

    const hasEthBudget = INITIAL_PROTOCOL_PARAMETERS.treasury.paymentRecipients.some(
      (recipient) => recipient.token === "ETH",
    );

    if (!hasEthBudget) return;

    expect(await protocolTreasury.approvedTokens(ethers.ZeroAddress)).to.equal(false);
  });
});
