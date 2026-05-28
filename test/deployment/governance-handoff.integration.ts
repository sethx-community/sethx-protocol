import { expect } from "chai";
import { network } from "hardhat";

import {
  readLocalDeployment,
  requireLocalAddress,
} from "../helpers/deployment-reader.js";

const { ethers } = await network.create();

async function expectRole(
  contractName: string,
  address: string,
  roleGetter: string,
  holder: string,
  expected: boolean,
) {
  const contract = await ethers.getContractAt(contractName, address);
  const role = await contract[roleGetter]();

  expect(await contract.hasRole(role, holder)).to.equal(expected);
}

function requireStage(deployment: ReturnType<typeof readLocalDeployment>, stage: string) {
  if (!deployment.stages?.[stage]) {
    throw new Error(`Full deployment must include Stage ${stage}`);
  }
}

describe("Final governance admin handoff", function () {
  it("grants Timelock core admin roles after Stage 88", async function () {
    const deployment = readLocalDeployment();
    requireStage(deployment, "88");

    const timelock = requireLocalAddress(deployment, "sethxTimelock");

    await expectRole(
      "AccountRegistry",
      requireLocalAddress(deployment, "accountRegistry"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "SethxVault",
      requireLocalAddress(deployment, "sethxVault"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "PriceManager",
      requireLocalAddress(deployment, "priceManager"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "FeeManager",
      requireLocalAddress(deployment, "feeManager"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );
  });

  it("grants Timelock risk, liquidation, treasury, and factory governance roles", async function () {
    const deployment = readLocalDeployment();
    requireStage(deployment, "88");

    const timelock = requireLocalAddress(deployment, "sethxTimelock");

    await expectRole(
      "ValuationModule",
      requireLocalAddress(deployment, "valuationModule"),
      "GOVERNOR_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "RiskModule",
      requireLocalAddress(deployment, "riskModule"),
      "GOVERNOR_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "LiquidationEngine",
      requireLocalAddress(deployment, "liquidationEngine"),
      "GOVERNOR_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "TreasuryAuthority",
      requireLocalAddress(deployment, "treasuryAuthority"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "LendingAccountFactory",
      requireLocalAddress(deployment, "lendingAccountFactory"),
      "GOVERNOR_ROLE",
      timelock,
      true,
    );
  });

  it("sets LendingAccountFactory accountGovernor to Timelock", async function () {
    const deployment = readLocalDeployment();
    requireStage(deployment, "88");

    const timelock = requireLocalAddress(deployment, "sethxTimelock");
    const lendingAccountFactory = await ethers.getContractAt(
      "LendingAccountFactory",
      requireLocalAddress(deployment, "lendingAccountFactory"),
    );

    expect(await lendingAccountFactory.accountGovernor()).to.equal(timelock);
  });

  it("removes deployer bootstrap roles if Stage 89 is part of the deployment", async function () {
    const deployment = readLocalDeployment();

    if (!deployment.stages?.["89"]) {
      return;
    }

    const [deployer] = await ethers.getSigners();
    const deployerAddress = await deployer.getAddress();

    await expectRole(
      "AccountRegistry",
      requireLocalAddress(deployment, "accountRegistry"),
      "DEFAULT_ADMIN_ROLE",
      deployerAddress,
      false,
    );

    await expectRole(
      "SethxVault",
      requireLocalAddress(deployment, "sethxVault"),
      "DEFAULT_ADMIN_ROLE",
      deployerAddress,
      false,
    );

    await expectRole(
      "FeeManager",
      requireLocalAddress(deployment, "feeManager"),
      "DEFAULT_ADMIN_ROLE",
      deployerAddress,
      false,
    );

    await expectRole(
      "TreasuryAuthority",
      requireLocalAddress(deployment, "treasuryAuthority"),
      "DEFAULT_ADMIN_ROLE",
      deployerAddress,
      false,
    );
  });
});
