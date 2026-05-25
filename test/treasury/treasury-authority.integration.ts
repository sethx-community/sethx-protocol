import { expect } from "chai";
import { network } from "hardhat";
import { readLocalDeployment } from "../helpers/deployment-reader.js";
import { expectCustomError } from "../helpers/assertions.js";

const { ethers } = await network.create();

async function snapshot() {
  return await ethers.provider.send("evm_snapshot", []);
}

async function revertToSnapshot(snapshotId: string) {
  await ethers.provider.send("evm_revert", [snapshotId]);
}

describe("TreasuryAuthority", function () {
  let snapshotId: string;

  beforeEach(async function () {
    snapshotId = await snapshot();
  });

  afterEach(async function () {
    await revertToSnapshot(snapshotId);
  });

  async function getDeployedAuthority() {
    const deployment = readLocalDeployment();

    const authority = (await ethers.getContractAt(
      "TreasuryAuthority",
      deployment.addresses.treasuryAuthority,
    )) as any;

    return {
      deployment,
      authority,
      governor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      treasurer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      guardian: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      stranger: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    };
  }

  it("is deployed from the local deployment output", async function () {
    const { deployment, authority } = await getDeployedAuthority();

    expect(deployment.environment).to.equal("local");
    expect(BigInt(deployment.chainId)).to.equal(31337n);
    expect(await authority.getAddress()).to.equal(
      deployment.addresses.treasuryAuthority,
    );
  });

  it("exposes the full intended permission set", async function () {
    const { authority } = await getDeployedAuthority();

    expect(await authority.PERMISSION_CALL_VAULT()).to.equal(1n << 0n);
    expect(await authority.PERMISSION_MANAGE_LIQUIDITY()).to.equal(1n << 1n);
    expect(await authority.PERMISSION_MANAGE_PAYMENTS()).to.equal(1n << 2n);
    expect(await authority.PERMISSION_TRADE_SETHX()).to.equal(1n << 3n);
    expect(await authority.PERMISSION_PUBLISH_PASSIVE_QUOTES()).to.equal(
      1n << 4n,
    );
    expect(await authority.PERMISSION_MANAGE_ORACLE_FUNDING()).to.equal(
      1n << 5n,
    );
  });

  it("allows governor to appoint a treasurer with passive quote and oracle funding permissions", async function () {
    const { authority, treasurer } = await getDeployedAuthority();

    const passiveQuotePermission =
      await authority.PERMISSION_PUBLISH_PASSIVE_QUOTES();
    const oracleFundingPermission =
      await authority.PERMISSION_MANAGE_ORACLE_FUNDING();
    const permissions = passiveQuotePermission | oracleFundingPermission;

    await authority.appointTreasurer(
      treasurer,
      "Operations Treasurer",
      permissions,
    );

    expect(await authority.isTreasurer(treasurer)).to.equal(true);
    expect(await authority.isOperationalTreasurer(treasurer)).to.equal(true);

    expect(
      await authority.hasPermission(treasurer, passiveQuotePermission),
    ).to.equal(true);
    expect(
      await authority.hasPermission(treasurer, oracleFundingPermission),
    ).to.equal(true);

    expect(
      await authority.canCallAsTreasurer(treasurer, passiveQuotePermission),
    ).to.equal(true);
    expect(
      await authority.canCallAsTreasurer(treasurer, oracleFundingPermission),
    ).to.equal(true);
  });

  it("rejects invalid permission bits", async function () {
    const { authority, treasurer } = await getDeployedAuthority();

    const invalidPermission = 1n << 99n;

    await expectCustomError(
      () =>
        authority.appointTreasurer(
          treasurer,
          "Invalid Treasurer",
          invalidPermission,
        ),
      "InvalidPermissions",
    );
  });

  it("allows guardian to freeze a treasurer but not govern", async function () {
    const { authority, treasurer, guardian } = await getDeployedAuthority();

    const permissions = await authority.PERMISSION_MANAGE_PAYMENTS();

    await authority.appointTreasurer(
      treasurer,
      "Payments Treasurer",
      permissions,
    );

    await authority.setGuardian(guardian, true);

    const guardianAuthority = authority.connect(
      await ethers.getSigner(guardian),
    ) as any;

    await guardianAuthority.freezeTreasurer(treasurer);

    expect(await authority.frozenTreasurers(treasurer)).to.equal(true);
    expect(await authority.isOperationalTreasurer(treasurer)).to.equal(false);
    expect(await authority.canCallAsTreasurer(treasurer, permissions)).to.equal(
      false,
    );

    await expectCustomError(
      () =>
        guardianAuthority.appointTreasurer(
          guardian,
          "Bad Governor",
          permissions,
        ),
      "Unauthorized",
    );
  });

  it("allows guardian to kill treasury operations but not unkill", async function () {
    const { authority, treasurer, guardian } = await getDeployedAuthority();

    const permissions = await authority.PERMISSION_MANAGE_PAYMENTS();

    await authority.appointTreasurer(
      treasurer,
      "Payments Treasurer",
      permissions,
    );

    await authority.setGuardian(guardian, true);

    const guardianAuthority = authority.connect(
      await ethers.getSigner(guardian),
    ) as any;

    await guardianAuthority.killTreasury();

    expect(await authority.killed()).to.equal(true);
    expect(await authority.isOperationalTreasurer(treasurer)).to.equal(false);
    expect(await authority.canCallAsTreasurer(treasurer, permissions)).to.equal(
      false,
    );

    await expectCustomError(
      () => guardianAuthority.unkillTreasury(),
      "Unauthorized",
    );

    await authority.unkillTreasury();

    expect(await authority.killed()).to.equal(false);
    expect(await authority.isOperationalTreasurer(treasurer)).to.equal(true);
    expect(await authority.canCallAsTreasurer(treasurer, permissions)).to.equal(
      true,
    );
  });

  it("does not allow a non-governor account to appoint treasurers", async function () {
    const { authority, treasurer, stranger } = await getDeployedAuthority();

    const strangerAuthority = authority.connect(
      await ethers.getSigner(stranger),
    ) as any;
    const permissions = await authority.PERMISSION_MANAGE_PAYMENTS();

    await expectCustomError(
      () =>
        strangerAuthority.appointTreasurer(
          treasurer,
          "Unauthorized Treasurer",
          permissions,
        ),
      "Unauthorized",
    );
  });
});
