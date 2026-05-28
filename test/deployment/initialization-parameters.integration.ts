import { expect } from "chai";
import { network } from "hardhat";

import { INITIAL_PROTOCOL_PARAMETERS } from "../../scripts/parameters/initial-protocol-parameters.js";
import {
  readLocalDeployment,
  requireLocalAddress,
} from "../helpers/deployment-reader.js";

const { ethers } = await network.create();

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

describe("Final initialization parameter verification", function () {
  async function loadDeployment() {
    const deployment = readLocalDeployment();

    const addresses = {
      sethxToken: requireLocalAddress(deployment, "sethxToken"),
      founderTokenTimelock: requireLocalAddress(deployment, "founderTokenTimelock"),
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

    const sethxToken = await ethers.getContractAt("SethxToken", addresses.sethxToken);
    const founderTokenTimelock = await ethers.getContractAt(
      "FounderTokenTimelock",
      addresses.founderTokenTimelock,
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
    const feeManager = await ethers.getContractAt("FeeManager", addresses.feeManager);
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
      founderTokenTimelock,
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
    const { deployment, sethxToken, founderTokenTimelock } = await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.token;

    expect(await sethxToken.name()).to.equal(params.name);
    expect(await sethxToken.symbol()).to.equal(params.symbol);
    expect(await sethxToken.decimals()).to.equal(params.decimals);
    expect(await sethxToken.totalSupply()).to.equal(params.totalSupply);

    expect(BigInt(deployment.tokenDistribution.totalSupply)).to.equal(
      params.totalSupply,
    );
    expect(BigInt(deployment.tokenDistribution.founderAmount)).to.equal(
      params.founderAllocation,
    );
    expect(BigInt(deployment.tokenDistribution.treasuryAmount)).to.equal(
      params.treasuryAllocation,
    );
    expect(params.founderAllocation + params.treasuryAllocation).to.equal(
      params.totalSupply,
    );

    expect(await founderTokenTimelock.beneficiary()).to.equal(
      deployment.founderAddress,
    );
    expect(await founderTokenTimelock.releaseTime()).to.equal(
      BigInt(deployment.founderReleaseTime),
    );
  });

  it("initializes governance parameters from parameters", async function () {
    const { deployment, sethxTimelock, sethxGovernor } = await loadDeployment();
    const params = INITIAL_PROTOCOL_PARAMETERS.governance;

    expect(await sethxTimelock.getMinDelay()).to.equal(
      params.timelockDelaySeconds,
    );
    expect(await sethxGovernor.votingDelay()).to.equal(params.votingDelayBlocks);
    expect(await sethxGovernor.votingPeriod()).to.equal(params.votingPeriodBlocks);
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
    expect(await feeManager.sethxDiscountBps()).to.equal(
      BigInt(feeParams.sethxDiscountBps),
    );
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
      expect(onchain.liquidationLtvBps).to.equal(BigInt(tier.liquidationLtvBps));
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

    for (const level of INITIAL_PROTOCOL_PARAMETERS.lendingRisk.lendingRiskLevels) {
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
    const { addresses, futuresOrderBook, accountRegistry } = await loadDeployment();

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
      await accountRegistry.hasRole(factoryRole, addresses.passiveFuturesPoolFactory),
    ).to.equal(true);
  });
});
