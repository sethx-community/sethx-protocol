import { expect } from "chai";
import { network } from "hardhat";

import { INITIAL_PROTOCOL_PARAMETERS } from "../../scripts/parameters/initial-protocol-parameters.js";
import {
  readLocalDeployment,
  requireLocalAddress,
} from "../helpers/deployment-reader.js";

const { ethers } = await network.create();

async function expectRevert(promise: Promise<unknown>) {
  try {
    await promise;
  } catch {
    return;
  }

  throw new Error("Expected transaction to revert");
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return BigInt(value.toString());
  }

  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

async function latestBlockTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("Latest block not found");
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

describe("Final initialization parameter verification", function () {
  async function loadDeployment() {
    const deployment = readLocalDeployment();

    const founderTokenTimelockConfigs =
      deployment.addresses.founderTokenTimelocks ?? [];

    const addresses = {
      sethxToken: requireLocalAddress(deployment, "sethxToken"),
      founderTokenTimelocks: founderTokenTimelockConfigs,
      protocolTreasury: requireLocalAddress(deployment, "protocolTreasury"),
      sethxTimelock: requireLocalAddress(deployment, "sethxTimelock"),
      sethxGovernor: requireLocalAddress(deployment, "sethxGovernor"),
      priceManager: requireLocalAddress(deployment, "priceManager"),
      feeManager: requireLocalAddress(deployment, "feeManager"),
      valuationModule: requireLocalAddress(deployment, "valuationModule"),
      lendingContract: requireLocalAddress(deployment, "lendingContract"),
      liquidationEngine: requireLocalAddress(deployment, "liquidationEngine"),
      accountRegistry: requireLocalAddress(deployment, "accountRegistry"),
      futuresOrderBook: requireLocalAddress(deployment, "futuresOrderBook"),
      passiveFuturesSnapshotPublisher: requireLocalAddress(
        deployment,
        "passiveFuturesSnapshotPublisher",
      ),
      passiveFuturesPoolFactory: requireLocalAddress(
        deployment,
        "passiveFuturesPoolFactory",
      ),
    };

    const sethxToken = await ethers.getContractAt(
      "SethxToken",
      addresses.sethxToken,
    );
    const founderTokenTimelocks = await Promise.all(
      addresses.founderTokenTimelocks.map((lock) =>
        ethers.getContractAt("FounderTokenTimelock", lock.address),
      ),
    );
    const sethxTimelock = await ethers.getContractAt(
      "SethxTimelock",
      addresses.sethxTimelock,
    );
    const sethxGovernor = await ethers.getContractAt(
      "SethxGovernor",
      addresses.sethxGovernor,
    );
    const priceManager = await ethers.getContractAt(
      "PriceManager",
      addresses.priceManager,
    );
    const feeManager = await ethers.getContractAt(
      "FeeManager",
      addresses.feeManager,
    );
    const valuationModule = await ethers.getContractAt(
      "ValuationModule",
      addresses.valuationModule,
    );
    const lendingContract = await ethers.getContractAt(
      "LendingContract",
      addresses.lendingContract,
    );
    const liquidationEngine = await ethers.getContractAt(
      "LiquidationEngine",
      addresses.liquidationEngine,
    );
    const accountRegistry = await ethers.getContractAt(
      "AccountRegistry",
      addresses.accountRegistry,
    );
    const futuresOrderBook = await ethers.getContractAt(
      "FuturesOrderBook",
      addresses.futuresOrderBook,
    );

    return {
      deployment,
      addresses,
      sethxToken,
      founderTokenTimelocks: founderTokenTimelockConfigs,
      sethxTimelock,
      sethxGovernor,
      priceManager,
      feeManager,
      valuationModule,
      lendingContract,
      liquidationEngine,
      accountRegistry,
      futuresOrderBook,
    };
  }

  it("records token distribution from parameters", async function () {
    const { deployment, sethxToken, founderTokenTimelocks } =
      await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.token;

    expect(await sethxToken.name()).to.equal(params.name);
    expect(await sethxToken.symbol()).to.equal(params.symbol);
    expect(await sethxToken.decimals()).to.equal(params.decimals);
    expect(await sethxToken.totalSupply()).to.equal(params.totalSupply);

    const founderTimelockConfigs = params.founderTimelocks ?? [];
    const expectedFounderAllocation = founderTimelockConfigs.reduce(
      (sum: bigint, lock: { allocationBps: bigint }) =>
        sum + (params.totalSupply * lock.allocationBps) / 10_000n,
      0n,
    );

    expect(BigInt(deployment.tokenDistribution.totalSupply)).to.equal(
      params.totalSupply,
    );
    expect(BigInt(deployment.tokenDistribution.founderAmount)).to.equal(
      params.founderAllocation ?? expectedFounderAllocation,
    );
    expect(
      BigInt(
        deployment.tokenDistribution.founderTimelockTotal ??
          deployment.tokenDistribution.founderAmount,
      ),
    ).to.equal(expectedFounderAllocation);
    expect(BigInt(deployment.tokenDistribution.treasuryAmount)).to.equal(
      params.treasuryAllocation,
    );
    expect(expectedFounderAllocation + params.treasuryAllocation).to.equal(
      params.totalSupply,
    );

    expect(deployment.addresses.founderTokenTimelocks).to.have.length(6);
    expect(founderTokenTimelocks).to.have.length(6);

    for (const [index, lock] of founderTokenTimelocks.entries()) {
      const config = deployment.addresses.founderTokenTimelocks![index];
      const founderLock = lock as any;
      expect(founderLock.beneficiary).to.equal(config.beneficiary);
      expect(BigInt(founderLock.releaseTime)).to.equal(
        BigInt(config.releaseTime),
      );
      expect(await sethxToken.balanceOf(config.address)).to.equal(
        BigInt(config.allocation),
      );
    }
  });

  it("keeps founder timelocks locked before release and releases after delay", async function () {
    const { deployment, sethxToken, founderTokenTimelocks } =
      await loadDeployment();

    const founderTimelocks = deployment.addresses?.founderTokenTimelocks ?? [];
    expect(founderTimelocks).to.have.length(6);

    const firstLock = founderTimelocks[0];

    const founderLock = await ethers.getContractAt(
      "FounderTokenTimelock",
      firstLock.address,
    );

    const beneficiary = firstLock.beneficiary;
    const allocation = BigInt(firstLock.allocation);

    expect(await sethxToken.balanceOf(firstLock.address)).to.equal(allocation);

    await expect(founderLock.release()).to.be.revert(ethers);

    await mineToTimestamp(BigInt(firstLock.releaseTime) + 1n);

    const before = await sethxToken.balanceOf(beneficiary);

    await founderLock.release();

    expect(await sethxToken.balanceOf(beneficiary)).to.equal(
      before + allocation,
    );
    expect(await sethxToken.balanceOf(firstLock.address)).to.equal(0n);

    await expect(founderLock.release()).to.be.revert(ethers);
  });
  it("initializes governance parameters from parameters", async function () {
    const { deployment, sethxTimelock, sethxGovernor } = await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.governance;

    expect(await sethxTimelock.getMinDelay()).to.equal(
      params.timelockDelaySeconds,
    );
    expect(await sethxGovernor.votingDelay()).to.equal(
      params.votingDelayBlocks,
    );
    expect(await sethxGovernor.votingPeriod()).to.equal(
      params.votingPeriodBlocks,
    );
    expect(await sethxGovernor.proposalThreshold()).to.equal(
      params.proposalThreshold,
    );
    expect(BigInt(deployment.governance!.quorumBps)).to.equal(
      BigInt(params.quorumBps),
    );
  });

  it("initializes oracle defaults and FeeManager base settings", async function () {
    const { addresses, priceManager, feeManager } = await loadDeployment();

    if (typeof priceManager.defaultStaleTimeoutSeconds === "function") {
      expect(await priceManager.defaultStaleTimeoutSeconds()).to.equal(
        INITIAL_PROTOCOL_PARAMETERS.oracleDefaults.staleTimeoutSeconds,
      );
    }

    const feeParams = INITIAL_PROTOCOL_PARAMETERS.feeManager;

    expect(await feeManager.feeUpdateDelay()).to.equal(
      BigInt(feeParams.feeUpdateDelaySeconds),
    );

    expect(await feeManager.isAcceptedFeeToken(ethers.ZeroAddress)).to.equal(
      feeParams.acceptEthFees,
    );

    expect(await feeManager.isAcceptedFeeToken(addresses.sethxToken)).to.equal(
      feeParams.acceptSethxFees,
    );

    // Delayed discount should be queued, not active.
    expect(await feeManager.sethxDiscountBps()).to.equal(0n);

    const pendingDiscount = await feeManager.pendingSethxDiscountUpdate();

    expect(pendingDiscount.discountBps).to.equal(
      BigInt(feeParams.sethxDiscountBps),
    );
    expect(pendingDiscount.executeAfter).to.be.gt(0n);

    for (const feeContext of feeParams.contexts) {
      // Active role fee config should still be empty until the delay has passed
      // and executeRoleFeeUpdate(context) is called.
      const active = await feeManager.getRoleFeeConfig(feeContext.context);

      expect(active.makerFixedFee).to.equal(0n);
      expect(active.makerPercentageFee).to.equal(0n);
      expect(active.takerFixedFee).to.equal(0n);
      expect(active.takerPercentageFee).to.equal(0n);
      expect(active.configured).to.equal(false);

      // The intended values should be queued.
      const pending = await feeManager.pendingRoleUpdates(feeContext.context);

      expect(pending.makerFixedFee).to.equal(
        BigInt(feeContext.makerFixedFeeEth),
      );
      expect(pending.makerPercentageFee).to.equal(
        BigInt(feeContext.makerPercentageFeeBps),
      );
      expect(pending.takerFixedFee).to.equal(
        BigInt(feeContext.takerFixedFeeEth),
      );
      expect(pending.takerPercentageFee).to.equal(
        BigInt(feeContext.takerPercentageFeeBps),
      );
      expect(pending.executeAfter).to.be.gt(0n);
    }
  });

  it("queues FeeManager role-fee contexts from parameters", async function () {
    const { feeManager } = await loadDeployment();

    for (const context of INITIAL_PROTOCOL_PARAMETERS.feeManager.contexts) {
      const current = await feeManager.roleFeeConfigs(context.context);
      const pending = await feeManager.pendingRoleUpdates(context.context);

      const activeMatches =
        current.configured === true &&
        current.makerFixedFee === context.makerFixedFeeEth &&
        current.makerPercentageFee === BigInt(context.makerPercentageFeeBps) &&
        current.takerFixedFee === context.takerFixedFeeEth &&
        current.takerPercentageFee === BigInt(context.takerPercentageFeeBps);

      if (activeMatches) continue;

      expect(pending.makerFixedFee).to.equal(context.makerFixedFeeEth);
      expect(pending.makerPercentageFee).to.equal(
        BigInt(context.makerPercentageFeeBps),
      );
      expect(pending.takerFixedFee).to.equal(context.takerFixedFeeEth);
      expect(pending.takerPercentageFee).to.equal(
        BigInt(context.takerPercentageFeeBps),
      );
      expect(pending.executeAfter).to.be.greaterThan(0n);
    }
  });

  it("initializes valuation and lending risk levels from parameters", async function () {
    const { valuationModule, lendingContract } = await loadDeployment();

    for (const tier of INITIAL_PROTOCOL_PARAMETERS.lendingRisk.valuationTiers) {
      const onchain = await valuationModule.riskTiers(tier.riskLevel);

      expect(onchain.enabled).to.equal(tier.enabled);
      expect(onchain.maxLtvBps).to.equal(BigInt(tier.maxLtvBps));
      expect(onchain.liquidationLtvBps).to.equal(
        BigInt(tier.liquidationLtvBps),
      );
      expect(onchain.longOptionHaircutBps).to.equal(
        BigInt(tier.longOptionHaircutBps),
      );
      expect(onchain.shortOptionHaircutBps).to.equal(
        BigInt(tier.shortOptionHaircutBps),
      );
      expect(onchain.bondHaircutBps).to.equal(BigInt(tier.bondHaircutBps));
      expect(onchain.futuresHaircutStepBps).to.equal(
        BigInt(tier.futuresHaircutStepBps),
      );
    }

    for (const level of INITIAL_PROTOCOL_PARAMETERS.lendingRisk
      .lendingRiskLevels) {
      const onchain = await lendingContract.riskLevels(level.riskLevel);

      expect(onchain.enabled).to.equal(level.enabled);
      expect(onchain.maxLtvBps).to.equal(BigInt(level.maxLtvBps));
      expect(onchain.liquidationLtvBps).to.equal(
        BigInt(level.liquidationLtvBps),
      );
    }
  });

  it("initializes liquidation auction parameters", async function () {
    const { liquidationEngine } = await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.liquidation;
    const config = await liquidationEngine.auctionConfig();

    expect(config.premiumPhaseDuration).to.equal(
      BigInt(params.premiumPhaseDuration),
    );
    expect(config.parPhaseDuration).to.equal(BigInt(params.parPhaseDuration));
    expect(config.discountPhaseDuration).to.equal(
      BigInt(params.discountPhaseDuration),
    );
    expect(config.startPriceBps).to.equal(BigInt(params.startPriceBps));
    expect(config.parPriceBps).to.equal(BigInt(params.parPriceBps));
    expect(config.endPriceBps).to.equal(BigInt(params.endPriceBps));
  });

  it("keeps constructor-default orderbook spam limits", async function () {
    const deployment = readLocalDeployment();

    const checks = [
      ["TokenSpotOrderBook", "tokenSpotOrderBook"],
      ["NFTSpotOrderBook", "nftSpotOrderBook"],
      ["OptionsOrderBook", "optionsOrderBook"],
      ["MarginOptionsOrderBook", "marginOptionsOrderBook"],
      ["BinaryMarginOptionsOrderBook", "binaryMarginOptionsOrderBook"],
      ["FuturesOrderBook", "futuresOrderBook"],
      ["LendingOrderBook", "lendingOrderBook"],
    ] as const;

    for (const [contractName, addressKey] of checks) {
      const address = requireLocalAddress(deployment, addressKey);
      const orderBook = await ethers.getContractAt(contractName, address);

      expect(await orderBook.maxOrdersPerBlock()).to.equal(20n);
      expect(await orderBook.maxUnmatchedOrders()).to.equal(100n);
    }
  });

  it("authorizes passive futures publisher and pool factory", async function () {
    const { addresses, futuresOrderBook, accountRegistry } =
      await loadDeployment();

    const publisherRole = await futuresOrderBook.PASSIVE_MM_PUBLISHER_ROLE();
    const adminRole = await futuresOrderBook.ADMIN_ROLE();
    const factoryRole = await accountRegistry.FACTORY_ROLE();

    expect(
      await futuresOrderBook.hasRole(
        publisherRole,
        addresses.passiveFuturesSnapshotPublisher,
      ),
    ).to.equal(true);

    expect(
      await futuresOrderBook.hasRole(
        adminRole,
        addresses.passiveFuturesPoolFactory,
      ),
    ).to.equal(true);

    expect(
      await accountRegistry.hasRole(
        factoryRole,
        addresses.passiveFuturesPoolFactory,
      ),
    ).to.equal(true);
  });
});
