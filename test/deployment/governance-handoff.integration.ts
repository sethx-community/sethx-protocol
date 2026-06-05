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

function contractHasFunction(contract: any, functionName: string): boolean {
  return contract.interface.fragments.some(
    (fragment: any) => fragment.type === "function" && fragment.name === functionName,
  );
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

    await expectRole(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
      "DEFAULT_ADMIN_ROLE",
      timelock,
      true,
    );

    await expectRole(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
      "GOVERNOR_ROLE",
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

  it("keeps LendingContract loss management least-privilege and removes the deprecated recovery surface", async function () {
    const deployment = readLocalDeployment();
    requireStage(deployment, "79");

    const lendingContract = await ethers.getContractAt(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
    );

    expect(
      contractHasFunction(lendingContract, "RECOVERY_MANAGER_ROLE"),
      "RECOVERY_MANAGER_ROLE was removed from LendingContract",
    ).to.equal(false);
    expect(
      contractHasFunction(lendingContract, "setRecoveryManager"),
      "setRecoveryManager was removed from LendingContract",
    ).to.equal(false);
    expect(
      contractHasFunction(lendingContract, "recordRecoveryFromVault"),
      "recordRecoveryFromVault was removed from LendingContract",
    ).to.equal(false);

    const lossManagerRole = await lendingContract.LOSS_MANAGER_ROLE();
    const liquidationEngine = requireLocalAddress(deployment, "liquidationEngine");
    const timelock = requireLocalAddress(deployment, "sethxTimelock");

    expect(
      await lendingContract.hasRole(lossManagerRole, liquidationEngine),
      "LiquidationEngine must be the operational LOSS_MANAGER_ROLE holder",
    ).to.equal(true);
    expect(
      await lendingContract.hasRole(lossManagerRole, timelock),
      "Timelock keeps GOVERNOR_ROLE but should not hold LOSS_MANAGER_ROLE directly",
    ).to.equal(false);
  });

  it("removes deployer bootstrap roles after Stage 89", async function () {
    const deployment = readLocalDeployment();
    requireStage(deployment, "89");

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

    await expectRole(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
      "DEFAULT_ADMIN_ROLE",
      deployerAddress,
      false,
    );

    await expectRole(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
      "GOVERNOR_ROLE",
      deployerAddress,
      false,
    );

    await expectRole(
      "LendingContract",
      requireLocalAddress(deployment, "lendingContract"),
      "LOSS_MANAGER_ROLE",
      deployerAddress,
      false,
    );
  });
});
