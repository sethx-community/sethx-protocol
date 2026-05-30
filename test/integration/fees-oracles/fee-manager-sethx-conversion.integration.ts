import { expect } from "chai";
import { network } from "hardhat";

import { INITIAL_PROTOCOL_PARAMETERS } from "../../../scripts/parameters/initial-protocol-parameters.js";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";

import { deployMockAssets } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const UNCONFIGURED_CONTEXT = "Unconfigured Integration Fee Context";
const INTEGRATION_CONTEXT = "ERC20 Spot Trade";
const WAD = 10n ** 18n;

function includesAddress(addresses: string[], target: string) {
  return addresses
    .map((address) => ethers.getAddress(address))
    .includes(ethers.getAddress(target));
}

async function latestBlockTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new Error("latest block unavailable");
  return BigInt(block.timestamp);
}


async function mineToTimestamp(timestamp: bigint) {
  const latest = await latestBlockTimestamp();
  if (latest >= timestamp) return;

  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
}

async function impersonateGovernanceAdmin(address: string) {
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x56BC75E2D63100000",
  ]);
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  return ethers.getSigner(address);
}

async function stopImpersonating(address: string) {
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
}



async function activateDeployedSethxDiscount(
  feeManager: any,
  expectedDiscountBps: bigint,
  governanceAdmin: string,
) {
  const activeBefore = await feeManager.sethxDiscountBps();
  if (activeBefore === expectedDiscountBps) return activeBefore;

  const pending = await feeManager.pendingSethxDiscountUpdate();
  expect(
    pending.discountBps,
    "SETHX discount must be queued by deployment initialization",
  ).to.equal(expectedDiscountBps);
  expect(
    pending.executeAfter,
    "SETHX discount executeAfter must be set",
  ).to.be.greaterThan(0n);

  await mineToTimestamp(pending.executeAfter);

  const timelockHasAdmin = await feeManager.hasRole(
    await feeManager.DEFAULT_ADMIN_ROLE(),
    governanceAdmin,
  );
  expect(
    timelockHasAdmin,
    "Timelock must hold FeeManager DEFAULT_ADMIN_ROLE after handoff",
  ).to.equal(true);

  const timelockSigner = await impersonateGovernanceAdmin(governanceAdmin);
  try {
    const tx = await feeManager
      .connect(timelockSigner)
      .executeSethxDiscountUpdate();
    await tx.wait();
  } finally {
    await stopImpersonating(governanceAdmin);
  }

  expect(await feeManager.sethxDiscountBps()).to.equal(expectedDiscountBps);
  const pendingAfter = await feeManager.pendingSethxDiscountUpdate();
  expect(pendingAfter.executeAfter).to.equal(0n);

  return expectedDiscountBps;
}

async function activateDeployedFeeContext(
  feeManager: any,
  contextName: string,
  governanceAdmin: string,
) {
  const activeBefore = await feeManager.roleFeeConfigs(contextName);
  if (activeBefore.configured) return activeBefore;

  const pending = await feeManager.pendingRoleUpdates(contextName);
  expect(
    pending.executeAfter,
    `${contextName} must be queued by deployment initialization before this test executes it`,
  ).to.be.greaterThan(0n);

  await mineToTimestamp(pending.executeAfter);

  const timelockHasAdmin = await feeManager.hasRole(
    await feeManager.DEFAULT_ADMIN_ROLE(),
    governanceAdmin,
  );
  expect(
    timelockHasAdmin,
    "Timelock must hold FeeManager DEFAULT_ADMIN_ROLE after handoff",
  ).to.equal(true);

  const timelockSigner = await impersonateGovernanceAdmin(governanceAdmin);
  try {
    const tx = await feeManager
      .connect(timelockSigner)
      .executeRoleFeeUpdate(contextName);
    await tx.wait();
  } finally {
    await stopImpersonating(governanceAdmin);
  }

  const activeAfter = await feeManager.roleFeeConfigs(contextName);
  expect(activeAfter.configured, `${contextName} must be active after execution`).to.equal(
    true,
  );

  const pendingAfter = await feeManager.pendingRoleUpdates(contextName);
  expect(
    pendingAfter.executeAfter,
    `${contextName} pending update must be cleared after execution`,
  ).to.equal(0n);

  return activeAfter;
}

async function expectConfiguredOrPendingFeeContext(
  feeManager: any,
  params: any,
) {
  const active = await feeManager.roleFeeConfigs(params.context);
  const pending = await feeManager.pendingRoleUpdates(params.context);

  const activeMatches =
    active.configured === true &&
    active.makerFixedFee === params.makerFixedFeeEth &&
    active.makerPercentageFee === BigInt(params.makerPercentageFeeBps) &&
    active.takerFixedFee === params.takerFixedFeeEth &&
    active.takerPercentageFee === BigInt(params.takerPercentageFeeBps);

  if (activeMatches) return;

  expect(pending.makerFixedFee, `${params.context} maker fixed`).to.equal(
    params.makerFixedFeeEth,
  );
  expect(
    pending.makerPercentageFee,
    `${params.context} maker percentage`,
  ).to.equal(BigInt(params.makerPercentageFeeBps));
  expect(pending.takerFixedFee, `${params.context} taker fixed`).to.equal(
    params.takerFixedFeeEth,
  );
  expect(
    pending.takerPercentageFee,
    `${params.context} taker percentage`,
  ).to.equal(BigInt(params.takerPercentageFeeBps));
  expect(
    pending.executeAfter,
    `${params.context} executeAfter`,
  ).to.be.greaterThan(0n);
}

describe("FeeManager and SETHX fee conversion oracle integration", function () {
  it("rejects malicious governance calls to every FeeManager mutating admin function", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const attackerAddress = await actors.attacker.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();

    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        "setPriceManager",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .setPriceManager(tokenAddress),
      ],
      [
        "setFeeUpdateDelay",
        () =>
          contracts.feeManager.connect(actors.attacker).setFeeUpdateDelay(2n),
      ],
      [
        "setAcceptedFeeToken",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .setAcceptedFeeToken(tokenAddress, true),
      ],
      [
        "setETHAsAcceptedFeeToken",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .setETHAsAcceptedFeeToken(false),
      ],
      [
        "queueSethxDiscountUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .queueSethxDiscountUpdate(1n),
      ],
      [
        "executeSethxDiscountUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .executeSethxDiscountUpdate(),
      ],
      [
        "cancelSethxDiscountUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .cancelSethxDiscountUpdate(),
      ],
      [
        "setAccountDiscount",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .setAccountDiscount(attackerAddress, 1n),
      ],
      [
        "queueRoleFeeUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .queueRoleFeeUpdate(INTEGRATION_CONTEXT, 1n, 1n, 1n, 1n),
      ],
      [
        "executeRoleFeeUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .executeRoleFeeUpdate(INTEGRATION_CONTEXT),
      ],
      [
        "cancelRoleFeeUpdate",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .cancelRoleFeeUpdate(INTEGRATION_CONTEXT),
      ],
      [
        "grantRole",
        () =>
          contracts.feeManager
            .connect(actors.attacker)
            .grantRole(ethers.ZeroHash, attackerAddress),
      ],
    ];

    for (const [, call] of calls) {
      await expectRevert(call());
    }

    expect(await contracts.feeManager.sethxToken()).to.equal(
      addresses.sethxToken,
    );
    expect(await contracts.feeManager.priceManager()).to.equal(
      addresses.priceManager,
    );
  });

  it("rejects malicious governance calls to the SETHX fee conversion oracle while leaving public fetch safe", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const attackerAddress = await actors.attacker.getAddress();
    const tokenAddress = await assets.tokenA.getAddress();

    await expectRevert(
      contracts.sethxFeeConversionOracle
        .connect(actors.attacker)
        .setSethxPerEth(1n),
    );

    await expectRevert(
      contracts.sethxFeeConversionOracle
        .connect(actors.attacker)
        .withdrawFundingToken(tokenAddress, attackerAddress, 1n),
    );

    await expectRevert(
      contracts.sethxFeeConversionOracle
        .connect(actors.attacker)
        .grantRole(ethers.ZeroHash, attackerAddress),
    );

    const before = await contracts.sethxFeeConversionOracle.getLastPrice();
    const tx = await contracts.sethxFeeConversionOracle
      .connect(actors.attacker)
      .fetchPrice();
    await tx.wait();
    const after = await contracts.sethxFeeConversionOracle.getLastPrice();

    expect(after.price).to.equal(before.price);
    expect(after.timestamp).to.equal(before.timestamp);
    expect(after.fetchTimestamp).to.be.greaterThanOrEqual(
      before.fetchTimestamp,
    );
    expect(await contracts.sethxFeeConversionOracle.decimals()).to.equal(18n);
    expect(await contracts.sethxFeeConversionOracle.sethxPerEth()).to.equal(
      INITIAL_PROTOCOL_PARAMETERS.sethxFeeConversionOracle.sethxPerEth,
    );
    expect(addresses.sethxFeeConversionOracle).to.match(/^0x[a-fA-F0-9]{40}$/);
  });

  it("validates deployed FeeManager payment-token and queued-context state", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const feeParams = INITIAL_PROTOCOL_PARAMETERS.feeManager;

    expect(await contracts.feeManager.isAcceptedFeeToken(ETH)).to.equal(
      feeParams.acceptEthFees,
    );
    expect(
      await contracts.feeManager.isAcceptedFeeToken(addresses.sethxToken),
    ).to.equal(feeParams.acceptSethxFees);
    const activeSethxDiscount = await contracts.feeManager.sethxDiscountBps();
    const pendingSethxDiscount =
      await contracts.feeManager.pendingSethxDiscountUpdate();

    if (activeSethxDiscount === BigInt(feeParams.sethxDiscountBps)) {
      expect(pendingSethxDiscount.executeAfter).to.equal(0n);
    } else {
      expect(activeSethxDiscount).to.equal(0n);
      expect(pendingSethxDiscount.discountBps).to.equal(
        BigInt(feeParams.sethxDiscountBps),
      );
      expect(pendingSethxDiscount.executeAfter).to.be.greaterThan(0n);
    }
    expect(await contracts.feeManager.feeUpdateDelay()).to.equal(
      BigInt(feeParams.feeUpdateDelaySeconds),
    );

    const acceptedTokens =
      await contracts.feeManager.getAcceptedPaymentTokens();

    if (feeParams.acceptEthFees) {
      expect(includesAddress(acceptedTokens, ETH)).to.equal(true);
    }
    if (feeParams.acceptSethxFees) {
      expect(includesAddress(acceptedTokens, addresses.sethxToken)).to.equal(
        true,
      );
    }

    for (const context of feeParams.contexts) {
      await expectConfiguredOrPendingFeeContext(contracts.feeManager, context);
    }
  });

  it("keeps unsupported fee tokens and invalid oracle funding inputs from producing state", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const assets = await deployMockAssets(ethers);

    const tokenAddress = await assets.tokenA.getAddress();
    const aliceAddress = await actors.alice.getAddress();

    await expectRevert(
      contracts.feeManager.getFeeForAccount(
        tokenAddress,
        ETH,
        ethers.parseEther("1"),
        UNCONFIGURED_CONTEXT,
        aliceAddress,
        false,
      ),
    );

    await expectRevert(
      contracts.sethxFeeConversionOracle
        .connect(actors.alice)
        .depositFundingToken(ethers.ZeroAddress, 1n),
    );

    await expectRevert(
      contracts.sethxFeeConversionOracle
        .connect(actors.alice)
        .depositFundingToken(tokenAddress, 0n),
    );

    expect(
      await contracts.sethxFeeConversionOracle.fundingTokenBalance(
        tokenAddress,
      ),
    ).to.equal(0n);
  });

  it("returns zero fees for an unconfigured context with an accepted payment token", async function () {
    const { contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);

    const aliceAddress = await actors.alice.getAddress();
    const fee = await contracts.feeManager.getFeeForAccount(
      ETH,
      ETH,
      ethers.parseEther("123.456"),
      UNCONFIGURED_CONTEXT,
      aliceAddress,
      false,
    );

    expect(fee.fixedAmount).to.equal(0n);
    expect(fee.fixedToken).to.equal(ETH);
    expect(fee.percentageAmount).to.equal(0n);
    expect(fee.percentageToken).to.equal(ETH);
  });

  it("exposes the deployed SETHX fee conversion oracle through PriceManager for exact ETH-to-SETHX conversion", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);

    const oracleAddress = addresses.sethxFeeConversionOracle;
    const feeConversionContext = 5n;
    const sethxPerEth =
      INITIAL_PROTOCOL_PARAMETERS.sethxFeeConversionOracle.sethxPerEth;
    const ethFee = ethers.parseEther("0.0125");
    const expectedSethxFee = (ethFee * sethxPerEth) / WAD;

    expect(
      await contracts.priceManager.tokenAllowedForContext(
        addresses.sethxToken,
        feeConversionContext,
      ),
      "SETHX must be allowed for FEE_CONVERSION",
    ).to.equal(true);

    expect(
      await contracts.priceManager.isOracleApprovedFor(
        oracleAddress,
        feeConversionContext,
      ),
      "SETHX fee oracle must be approved for FEE_CONVERSION",
    ).to.equal(true);

    expect(
      await contracts.priceManager.isOracleUsableForFeeConversion(oracleAddress),
      "SETHX fee oracle must be currently usable for FEE_CONVERSION",
    ).to.equal(true);

    const registeredOracles = await contracts.priceManager.getOraclesForTokenContext(
      addresses.sethxToken,
      feeConversionContext,
    );
    expect(
      includesAddress(registeredOracles, oracleAddress),
      "SETHX fee oracle must be registered for the SETHX/FEE_CONVERSION token-context pair",
    ).to.equal(true);

    const rate = await contracts.priceManager.getFeeConversionRate(
      addresses.sethxToken,
    );
    expect(rate.tokenPerEthE18).to.equal(sethxPerEth);
    expect(rate.oracle).to.equal(oracleAddress);

    expect(
      await contracts.priceManager.convertEthFeeToToken(
        addresses.sethxToken,
        ethFee,
      ),
    ).to.equal(expectedSethxFee);
  });

  it("mines past the fee delay and calculates ERC20 Spot Trade SETHX fixed and percentage fees", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const feeParams = INITIAL_PROTOCOL_PARAMETERS.feeManager;
    const context = feeParams.contexts.find(
      (candidate) => candidate.context === INTEGRATION_CONTEXT,
    );

    expect(context, `${INTEGRATION_CONTEXT} fee params missing`).to.not.equal(
      undefined,
    );

    await activateDeployedSethxDiscount(
      contracts.feeManager,
      BigInt(feeParams.sethxDiscountBps),
      addresses.sethxTimelock,
    );

    const active = await activateDeployedFeeContext(
      contracts.feeManager,
      INTEGRATION_CONTEXT,
      addresses.sethxTimelock,
    );

    expect(active.makerFixedFee).to.equal(context!.makerFixedFeeEth);
    expect(active.makerPercentageFee).to.equal(
      BigInt(context!.makerPercentageFeeBps),
    );
    expect(active.takerFixedFee).to.equal(context!.takerFixedFeeEth);
    expect(active.takerPercentageFee).to.equal(
      BigInt(context!.takerPercentageFeeBps),
    );

    const aliceAddress = await actors.alice.getAddress();
    const assetValue = ethers.parseEther("2.5");
    const fee = await contracts.feeManager.getFeeForAccount(
      addresses.sethxToken,
      ETH,
      assetValue,
      INTEGRATION_CONTEXT,
      aliceAddress,
      false,
    );

    const sethxPerEth =
      INITIAL_PROTOCOL_PARAMETERS.sethxFeeConversionOracle.sethxPerEth;
    const globalDiscount = BigInt(feeParams.sethxDiscountBps);

    const rawFixed = (context!.takerFixedFeeEth * sethxPerEth) / WAD;
    const rawPercentage =
      (((assetValue * BigInt(context!.takerPercentageFeeBps)) / 10_000n) *
        sethxPerEth) /
      WAD;
    const expectedFixed = (rawFixed * (10_000n - globalDiscount)) / 10_000n;
    const expectedPercentage =
      (rawPercentage * (10_000n - globalDiscount)) / 10_000n;

    expect(fee.fixedToken).to.equal(addresses.sethxToken);
    expect(fee.percentageToken).to.equal(addresses.sethxToken);
    expect(fee.fixedAmount).to.equal(expectedFixed);
    expect(fee.percentageAmount).to.equal(expectedPercentage);
  });
});
