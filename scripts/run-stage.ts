import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

import { LOCAL_DEPLOYMENT_CONFIG } from "./config/local.js";
import { getTestnetDeploymentConfig } from "./config/testnet.js";
import { getMainnetDeploymentConfig } from "./config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "./parameters/initial-protocol-parameters.js";
import { deployTokenAndTreasury } from "./deploy/00-deploy-token-and-treasury.js";
import { setupTokenDistribution } from "./setup/10-token-distribution.js";
import { deployGovernance } from "./deploy/20-deploy-governance.js";
import { setupGovernance } from "./setup/21-setup-governance.js";
import { writeDeploymentOutput } from "./output/write-deployment.js";
import { deployVault } from "./deploy/30-deploy-vault.js";
import { deployPriceManager } from "./deploy/40-deploy-price-manager.js";
import { deployFeeManager } from "./deploy/41-deploy-fee-manager.js";
import { deployTokenSpotOrderBook } from "./deploy/50-deploy-token-spot-orderbook.js";
import { setupTokenSpotOrderBook } from "./setup/51-setup-token-spot-orderbook.js";
import { deployNftSpotOrderBook } from "./deploy/52-deploy-nft-spot-orderbook.js";
import { setupNftSpotOrderBook } from "./setup/53-setup-nft-spot-orderbook.js";
import { deployOptionContract } from "./deploy/54-deploy-option-contract.js";
import { deployOptionsOrderBook } from "./deploy/55-deploy-options-orderbook.js";
import { setupOptions } from "./setup/56-setup-options.js";
import { deployBinaryMarginOptionContract } from "./deploy/57-deploy-binary-margin-option-contract.js";
import { deployBinaryMarginOptionsOrderBook } from "./deploy/58-deploy-binary-margin-options-orderbook.js";
import { setupBinaryMarginOptions } from "./setup/59-setup-binary-margin-options.js";
import { deployMarginOptionContract } from "./deploy/60-deploy-margin-option-contract.js";
import { deployMarginOptionsOrderBook } from "./deploy/61-deploy-margin-options-orderbook.js";
import { setupMarginOptions } from "./setup/62-setup-margin-options.js";
import { deployFuturesContract } from "./deploy/63-deploy-futures-contract.js";
import { deployFuturesOrderBook } from "./deploy/64-deploy-futures-orderbook.js";
import { setupFutures } from "./setup/65-setup-futures.js";

import { deployLendingContract } from "./deploy/68-deploy-lending-contract.js";
import { deployLendingOrderBook } from "./deploy/69-deploy-lending-orderbook.js";
import { setupLending } from "./setup/70-setup-lending.js";
import { deployOptionsValuationAdapter } from "./deploy/71-deploy-options-valuation-adapter.js";
import { deployFuturesValuationAdapter } from "./deploy/72-deploy-futures-valuation-adapter.js";
import { deployValuationModule } from "./deploy/73-deploy-valuation-module.js";
import { deployRiskModule } from "./deploy/74-deploy-risk-module.js";
import { setupLendingRisk } from "./setup/75-setup-lending-risk.js";
import { deployLiquidationEngine } from "./deploy/76-deploy-liquidation-engine.js";
import { deployAccountFactory } from "./deploy/77-deploy-account-factory.js";
import { deployLendingAccountFactory } from "./deploy/78-deploy-lending-account-factory.js";
import { setupAccountFactories } from "./setup/79-setup-account-factories.js";
import { deployTreasuryPaymentsModule } from "./deploy/80-deploy-treasury-payments-module.js";
import { deployTreasuryVaultModule } from "./deploy/81-deploy-treasury-vault-module.js";
import { deployTreasuryTradeModule } from "./deploy/82-deploy-treasury-trade-module.js";
import { setupTreasuryModules } from "./setup/83-setup-treasury-modules.js";
import { deploySethxFeeConversionOracle } from "./deploy/84-deploy-sethx-fee-conversion-oracle.js";
import { setupSethxFeeConversionOracle } from "./setup/84-setup-sethx-fee-conversion-oracle.js";
import { deployTokenEthOracles } from "./deploy/84-deploy-token-eth-oracles.js";
import { setupTokenEthOracles } from "./setup/84-setup-token-eth-oracles.js";
import { deployPassiveFuturesSnapshotPublisher } from "./deploy/85-deploy-passive-futures-snapshot-publisher.js";
import { deployPassiveFuturesPoolFactory } from "./deploy/86-deploy-passive-futures-pool-factory.js";
import { setupPassiveFutures } from "./setup/87-setup-passive-futures.js";
import { setupFeeManager } from "./setup/42-setup-fee-manager.js";
import { setupGovernanceAdminHandoff } from "./setup/88-setup-governance-admin-handoff.js";
import { revokeBootstrapAdmin } from "./setup/89-revoke-bootstrap-admin.js";

type SethxEnvironment = "local" | "testnet" | "mainnet";
type SethxStage =
  | "00"
  | "10"
  | "20"
  | "21"
  | "30"
  | "40"
  | "41"
  | "42"
  | "50"
  | "51"
  | "52"
  | "53"
  | "54"
  | "55"
  | "56"
  | "57"
  | "58"
  | "59"
  | "60"
  | "61"
  | "62"
  | "63"
  | "64"
  | "65"
  | "68"
  | "69"
  | "70"
  | "71"
  | "72"
  | "73"
  | "74"
  | "75"
  | "76"
  | "77"
  | "78"
  | "79"
  | "80"
  | "81"
  | "82"
  | "83"
  | "84"
  | "85"
  | "86"
  | "87"
  | "88"
  | "89";

type DeploymentConfig = {
  environment: SethxEnvironment;
  expectedChainId: bigint;
  outputDir: string;
  founderAddresses: readonly string[];
};

type DeploymentOutput = {
  environment: SethxEnvironment;
  chainId: bigint | string | number;
  deployedAt: string;
  updatedAt?: string;
  founderAddresses: readonly string[];
  founderReleaseTime?: bigint | string;
  addresses?: {
    sethxToken?: string;
    founderTokenTimelocks?: {
      id: string;
      founderIndex: number;
      beneficiary: string;
      releaseDelaySeconds: bigint | string;
      releaseTime: bigint | string;
      allocationBps: bigint | string;
      allocation: bigint | string;
      address: string;
    }[];
    treasuryAuthority?: string;
    protocolTreasury?: string;
    sethxTimelock?: string;
    sethxGovernor?: string;
    accountRegistry?: string;
    sethxVault?: string;
    priceManager?: string;
    feeManager?: string;
    tokenSpotOrderBook?: string;
    nftSpotOrderBook?: string;
    optionContract?: string;
    optionsOrderBook?: string;
    binaryMarginOptionContract?: string;
    binaryMarginOptionsOrderBook?: string;
    marginOptionContract?: string;
    marginOptionsOrderBook?: string;
    futuresContract?: string;
    futuresPositionStore?: string;
    futuresOrderBook?: string;
    lendingContract?: string;
    lendingOrderBook?: string;
    optionsValuationAdapter?: string;
    futuresValuationAdapter?: string;
    valuationModule?: string;
    riskModule?: string;
    liquidationEngine?: string;
    accountFactory?: string;
    lendingAccountFactory?: string;
    treasuryPaymentsModule?: string;
    treasuryVaultModule?: string;
    treasuryTradeModule?: string;
    treasuryFuturesMaintenanceModule?: string;
    sethxFeeConversionOracle?: string;
    usdcToken?: string;
    wbtcToken?: string;
    usdcEthFeed?: string;
    wbtcEthFeed?: string;
    usdcEthOracle?: string;
    wbtcEthOracle?: string;
    passiveFuturesSnapshotPublisher?: string;
    passiveFuturesPoolFactory?: string;
    [key: string]: unknown;
  };
  tokenDistribution?: {
    totalSupply: bigint | string;
    founderAmount: bigint | string;
    founderTimelockTotal?: bigint | string;
    founderTimelocks?: {
      address: string;
      allocation: bigint | string;
    }[];
    treasuryAmount: bigint | string;
  };
  governance?: Record<string, unknown>;
  roles?: Record<string, unknown>;
  stages?: Record<
    string,
    {
      completedAt: string;
      description: string;
    }
  >;
  [key: string]: unknown;
};

function optionalAddress(existing: any, key: string): string | undefined {
  const value = existing.addresses?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getEnvironmentName(): SethxEnvironment {
  const environment = process.env.SETHX_DEPLOYMENT_ENVIRONMENT;

  if (
    environment === "local" ||
    environment === "testnet" ||
    environment === "mainnet"
  ) {
    return environment;
  }

  throw new Error(
    "SETHX_DEPLOYMENT_ENVIRONMENT must be local, testnet, or mainnet",
  );
}

function getDeploymentConfig(): DeploymentConfig {
  const environment = getEnvironmentName();

  if (environment === "local") return LOCAL_DEPLOYMENT_CONFIG;
  if (environment === "testnet") return getTestnetDeploymentConfig();
  return getMainnetDeploymentConfig();
}

function getRequestedStage(): SethxStage {
  const stage = process.env.SETHX_DEPLOYMENT_STAGE;

  if (
    stage === "00" ||
    stage === "10" ||
    stage === "20" ||
    stage === "21" ||
    stage === "30" ||
    stage === "40" ||
    stage === "41" ||
    stage === "42" ||
    stage === "50" ||
    stage === "51" ||
    stage === "52" ||
    stage === "53" ||
    stage === "54" ||
    stage === "55" ||
    stage === "56" ||
    stage === "57" ||
    stage === "58" ||
    stage === "59" ||
    stage === "60" ||
    stage === "61" ||
    stage === "62" ||
    stage === "63" ||
    stage === "64" ||
    stage === "65" ||
    stage === "68" ||
    stage === "69" ||
    stage === "70" ||
    stage === "71" ||
    stage === "72" ||
    stage === "73" ||
    stage === "74" ||
    stage === "75" ||
    stage === "76" ||
    stage === "77" ||
    stage === "78" ||
    stage === "79" ||
    stage === "80" ||
    stage === "81" ||
    stage === "82" ||
    stage === "83" ||
    stage === "84" ||
    stage === "85" ||
    stage === "86" ||
    stage === "87" ||
    stage === "88" ||
    stage === "89"
  ) {
    return stage;
  }

  throw new Error(
    "Missing or invalid stage. Use SETHX_DEPLOYMENT_STAGE=00/10/20/21/30/40/41/42/50/51/52/53/54/55/56/57/58/59/60/61/62/63/64/65/68/69/70/71/72/73/74/75/76/77/78/79/80/81/82/83/84/85/86/87/88/89 to specify a stage.",
  );
}

function latestDeploymentPath(outputDir: string) {
  return path.join(outputDir, "latest.json");
}

function readDeploymentOutput(outputDir: string): DeploymentOutput {
  const latestPath = latestDeploymentPath(outputDir);

  if (!fs.existsSync(latestPath)) {
    throw new Error(
      `Missing deployment output at ${latestPath}. Run the required earlier stage first.`,
    );
  }

  return JSON.parse(fs.readFileSync(latestPath, "utf8")) as DeploymentOutput;
}

function assertStageNotCompleted(output: DeploymentOutput, stage: SethxStage) {
  if (output.stages?.[stage]) {
    throw new Error(
      `Stage ${stage} is already marked complete. Refusing to rerun without an explicit migration/override script.`,
    );
  }
}

function assertStageCompleted(output: DeploymentOutput, stage: SethxStage) {
  if (!output.stages?.[stage]) {
    throw new Error(`Stage ${stage} must be completed before this stage.`);
  }
}

function markStageComplete(
  output: DeploymentOutput,
  stage: SethxStage,
  description: string,
): DeploymentOutput {
  return {
    ...output,
    updatedAt: new Date().toISOString(),
    stages: {
      ...(output.stages ?? {}),
      [stage]: {
        completedAt: new Date().toISOString(),
        description,
      },
    },
  };
}

function requireAddress(
  output: DeploymentOutput,
  key: keyof NonNullable<DeploymentOutput["addresses"]>,
): string {
  const address = output.addresses?.[key];

  if (typeof address !== "string" || address.length === 0) {
    throw new Error(`Deployment output is missing addresses.${String(key)}`);
  }

  return address;
}

async function assertExpectedChainId(ethers: any, config: DeploymentConfig) {
  const chain = await ethers.provider.getNetwork();

  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  return chain;
}

async function runStage00(ethers: any, config: DeploymentConfig) {
  const existingPath = latestDeploymentPath(config.outputDir);

  if (fs.existsSync(existingPath)) {
    const existing = readDeploymentOutput(config.outputDir);
    if (existing.addresses && Object.keys(existing.addresses).length > 0) {
      throw new Error(
        `Deployment output already exists at ${existingPath}. Refusing to redeploy token/treasury stage.`,
      );
    }
  }

  const chain = await assertExpectedChainId(ethers, config);

  const deployment = await deployTokenAndTreasury(
    ethers,
    config,
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const output = markStageComplete(
    {
      environment: config.environment,
      chainId: chain.chainId,
      deployedAt: new Date().toISOString(),
      founderAddresses: config.founderAddresses,
      addresses: deployment.addresses,
    },
    "00",
    "Deploy SETHX token, six founder timelocks, TreasuryAuthority, and ProtocolTreasury",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage10(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);
  assertStageCompleted(existing, "00");
  assertStageNotCompleted(existing, "10");

  const sethxTokenAddress = requireAddress(existing, "sethxToken");
  const founderTokenTimelocks = existing.addresses?.founderTokenTimelocks;
  if (
    !Array.isArray(founderTokenTimelocks) ||
    founderTokenTimelocks.length !== 6
  ) {
    throw new Error("Missing founderTokenTimelocks in deployment output");
  }

  const protocolTreasury = requireAddress(existing, "protocolTreasury");

  const sethxToken = await ethers.getContractAt(
    "SethxToken",
    sethxTokenAddress,
  );

  const distribution = await setupTokenDistribution(
    INITIAL_PROTOCOL_PARAMETERS,
    {
      sethxToken,
      addresses: {
        founderTokenTimelocks: founderTokenTimelocks.map((lock, index) => {
          const lockRecord = lock as {
            address?: unknown;
            allocation?: unknown;
          };

          if (
            typeof lockRecord.address !== "string" ||
            lockRecord.address.length === 0
          ) {
            throw new Error(
              `Founder timelock ${index + 1} is missing an address`,
            );
          }

          if (
            typeof lockRecord.allocation !== "string" &&
            typeof lockRecord.allocation !== "bigint"
          ) {
            throw new Error(
              `Founder timelock ${index + 1} is missing an allocation`,
            );
          }

          return {
            address: lockRecord.address,
            allocation: BigInt(lockRecord.allocation),
          };
        }),
        protocolTreasury,
      },
    },
  );

  const output = markStageComplete(
    {
      ...existing,
      tokenDistribution: distribution,
    },
    "10",
    "Mint founder allocations to timelocks, mint treasury allocation, and finish minting",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage20(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);
  assertStageCompleted(existing, "00");
  assertStageCompleted(existing, "10");
  assertStageNotCompleted(existing, "20");

  const sethxToken = requireAddress(existing, "sethxToken");
  const protocolTreasury = requireAddress(existing, "protocolTreasury");

  const governanceDeployment = await deployGovernance(
    ethers,
    INITIAL_PROTOCOL_PARAMETERS,
    {
      addresses: {
        sethxToken,
        protocolTreasury,
      },
    },
  );

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...governanceDeployment.addresses,
      },
      governance: governanceDeployment.governance,
    },
    "20",
    "Deploy SethxTimelock and SethxGovernor",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage21(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);
  assertStageCompleted(existing, "20");
  assertStageNotCompleted(existing, "21");

  const sethxTimelock = requireAddress(existing, "sethxTimelock");
  const sethxGovernor = requireAddress(existing, "sethxGovernor");

  const governanceSetup = await setupGovernance(ethers, {
    addresses: {
      sethxTimelock,
      sethxGovernor,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...governanceSetup.roles,
      },
    },
    "21",
    "Configure Timelock proposer, canceller, executor, and keep deployer admin until final handoff",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage30(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "20");
  assertStageCompleted(existing, "21");
  assertStageNotCompleted(existing, "30");

  const sethxToken = requireAddress(existing, "sethxToken");

  const vaultDeployment = await deployVault(ethers, {
    addresses: {
      sethxToken,
      accountRegistry: existing.addresses?.accountRegistry,
      sethxVault: existing.addresses?.sethxVault,
    },
    onCheckpoint: (addresses) => {
      const latest = readDeploymentOutput(config.outputDir);

      writeDeploymentOutput(config.outputDir, {
        ...latest,
        addresses: {
          ...(latest.addresses ?? {}),
          ...addresses,
        },
        updatedAt: new Date().toISOString(),
      });
    },
  });

  const latest = readDeploymentOutput(config.outputDir);

  const output = markStageComplete(
    {
      ...latest,
      addresses: {
        ...(latest.addresses ?? {}),
        ...vaultDeployment.addresses,
      },
    },
    "30",
    "Deploy AccountRegistry and SethxVault",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage40(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);
  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "40");

  const priceManagerDeployment = await deployPriceManager(
    ethers,
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...priceManagerDeployment.addresses,
      },
      oracleDefaults: {
        ...(typeof existing.oracleDefaults === "object" &&
        existing.oracleDefaults !== null
          ? existing.oracleDefaults
          : {}),
        ...priceManagerDeployment.oracleDefaults,
      },
    },
    "40",
    "Deploy PriceManager",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage41(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);
  assertStageCompleted(existing, "40");
  assertStageNotCompleted(existing, "41");

  const sethxToken = requireAddress(existing, "sethxToken");
  const priceManager = requireAddress(existing, "priceManager");

  const feeManagerDeployment = await deployFeeManager(ethers, {
    addresses: {
      sethxToken,
      priceManager,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...feeManagerDeployment.addresses,
      },
    },
    "41",
    "Deploy FeeManager",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage42(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "41");
  assertStageNotCompleted(existing, "42");

  const feeManager = requireAddress(existing, "feeManager");
  const sethxToken = requireAddress(existing, "sethxToken");

  const setup = await setupFeeManager(ethers, {
    addresses: {
      feeManager,
      sethxToken,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      feeManager: setup.feeManager,
    },
    "42",
    "Configure FeeManager accepted fee tokens, delay, and queued fee/discount updates",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage50(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageCompleted(existing, "40");
  assertStageCompleted(existing, "42");
  assertStageNotCompleted(existing, "50");

  const sethxVault = requireAddress(existing, "sethxVault");
  const feeManager = requireAddress(existing, "feeManager");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const tokenSpotOrderBookDeployment = await deployTokenSpotOrderBook(ethers, {
    addresses: {
      sethxVault,
      feeManager,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...tokenSpotOrderBookDeployment.addresses,
      },
    },
    "50",
    "Deploy TokenSpotOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage51(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "50");
  assertStageNotCompleted(existing, "51");

  const sethxVault = requireAddress(existing, "sethxVault");
  const tokenSpotOrderBook = requireAddress(existing, "tokenSpotOrderBook");

  const setup = await setupTokenSpotOrderBook(ethers, {
    addresses: {
      sethxVault,
      tokenSpotOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "51",
    "Grant TokenSpotOrderBook ORDERBOOK_ROLE on SethxVault",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage52(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageCompleted(existing, "40");
  assertStageCompleted(existing, "42");
  assertStageNotCompleted(existing, "52");

  const sethxVault = requireAddress(existing, "sethxVault");
  const feeManager = requireAddress(existing, "feeManager");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const nftSpotOrderBookDeployment = await deployNftSpotOrderBook(ethers, {
    addresses: {
      sethxVault,
      feeManager,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...nftSpotOrderBookDeployment.addresses,
      },
    },
    "52",
    "Deploy NFTSpotOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage53(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "52");
  assertStageNotCompleted(existing, "53");

  const sethxVault = requireAddress(existing, "sethxVault");
  const nftSpotOrderBook = requireAddress(existing, "nftSpotOrderBook");

  const setup = await setupNftSpotOrderBook(ethers, {
    addresses: {
      sethxVault,
      nftSpotOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "53",
    "Grant NFTSpotOrderBook ORDERBOOK_ROLE on SethxVault",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage54(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "54");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const optionContractDeployment = await deployOptionContract(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...optionContractDeployment.addresses,
      },
    },
    "54",
    "Deploy OptionContract",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage55(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "42");
  assertStageCompleted(existing, "54");
  assertStageNotCompleted(existing, "55");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const optionContract = requireAddress(existing, "optionContract");
  const feeManager = requireAddress(existing, "feeManager");

  const optionsOrderBookDeployment = await deployOptionsOrderBook(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      optionContract,
      feeManager,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...optionsOrderBookDeployment.addresses,
      },
    },
    "55",
    "Deploy OptionsOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage56(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "55");
  assertStageNotCompleted(existing, "56");

  const sethxVault = requireAddress(existing, "sethxVault");
  const optionContract = requireAddress(existing, "optionContract");
  const optionsOrderBook = requireAddress(existing, "optionsOrderBook");

  const setup = await setupOptions(
    ethers,
    {
      addresses: {
        sethxVault,
        optionContract,
        optionsOrderBook,
      },
    },
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "56",
    "Grant OptionContract and OptionsOrderBook protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage57(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "57");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const deployment = await deployBinaryMarginOptionContract(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "57",
    "Deploy BinaryMarginOptionContract",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage58(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "42");
  assertStageCompleted(existing, "57");
  assertStageNotCompleted(existing, "58");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const binaryMarginOptionContract = requireAddress(
    existing,
    "binaryMarginOptionContract",
  );
  const feeManager = requireAddress(existing, "feeManager");

  const deployment = await deployBinaryMarginOptionsOrderBook(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      binaryMarginOptionContract,
      feeManager,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "58",
    "Deploy BinaryMarginOptionsOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage59(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "58");
  assertStageNotCompleted(existing, "59");

  const sethxVault = requireAddress(existing, "sethxVault");
  const priceManager = requireAddress(existing, "priceManager");
  const binaryMarginOptionContract = requireAddress(
    existing,
    "binaryMarginOptionContract",
  );
  const binaryMarginOptionsOrderBook = requireAddress(
    existing,
    "binaryMarginOptionsOrderBook",
  );

  const setup = await setupBinaryMarginOptions(
    ethers,
    {
      addresses: {
        sethxVault,
        priceManager,
        binaryMarginOptionContract,
        binaryMarginOptionsOrderBook,
      },
    },
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "59",
    "Grant BinaryMarginOptionContract and BinaryMarginOptionsOrderBook protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage60(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "60");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const deployment = await deployMarginOptionContract(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "60",
    "Deploy MarginOptionContract",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage61(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "42");
  assertStageCompleted(existing, "60");
  assertStageNotCompleted(existing, "61");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const marginOptionContract = requireAddress(existing, "marginOptionContract");
  const feeManager = requireAddress(existing, "feeManager");

  const deployment = await deployMarginOptionsOrderBook(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      marginOptionContract,
      feeManager,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "61",
    "Deploy MarginOptionsOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage62(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "61");
  assertStageNotCompleted(existing, "62");

  const sethxVault = requireAddress(existing, "sethxVault");
  const priceManager = requireAddress(existing, "priceManager");
  const marginOptionContract = requireAddress(existing, "marginOptionContract");
  const marginOptionsOrderBook = requireAddress(
    existing,
    "marginOptionsOrderBook",
  );

  const setup = await setupMarginOptions(
    ethers,
    {
      addresses: {
        sethxVault,
        priceManager,
        marginOptionContract,
        marginOptionsOrderBook,
      },
    },
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "62",
    "Grant MarginOptionContract and MarginOptionsOrderBook protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage63(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "63");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");

  const deployment = await deployFuturesContract(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "63",
    "Deploy FuturesContract and FuturesPositionStore",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage64(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "42");
  assertStageCompleted(existing, "63");
  assertStageNotCompleted(existing, "64");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const futuresContract = requireAddress(existing, "futuresContract");
  const feeManager = requireAddress(existing, "feeManager");

  const deployment = await deployFuturesOrderBook(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      futuresContract,
      feeManager,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "64",
    "Deploy FuturesOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage65(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "40");
  assertStageCompleted(existing, "64");
  assertStageNotCompleted(existing, "65");

  const sethxVault = requireAddress(existing, "sethxVault");
  const priceManager = requireAddress(existing, "priceManager");
  const futuresContract = requireAddress(existing, "futuresContract");
  const futuresPositionStore = requireAddress(existing, "futuresPositionStore");
  const futuresOrderBook = requireAddress(existing, "futuresOrderBook");

  const setup = await setupFutures(ethers, {
    addresses: {
      sethxVault,
      priceManager,
      futuresContract,
      futuresPositionStore,
      futuresOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "65",
    "Grant FuturesContract, FuturesPositionStore, and FuturesOrderBook protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage68(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "30");
  assertStageNotCompleted(existing, "68");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");

  const deployment = await deployLendingContract(ethers, {
    addresses: {
      accountRegistry,
      sethxVault,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "68",
    "Deploy LendingContract",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage69(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "68");
  assertStageNotCompleted(existing, "69");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const lendingContract = requireAddress(existing, "lendingContract");

  const deployment = await deployLendingOrderBook(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      lendingContract,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "69",
    "Deploy LendingOrderBook",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage70(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "69");
  assertStageNotCompleted(existing, "70");

  const sethxVault = requireAddress(existing, "sethxVault");
  const lendingContract = requireAddress(existing, "lendingContract");
  const lendingOrderBook = requireAddress(existing, "lendingOrderBook");

  const setup = await setupLending(ethers, {
    addresses: {
      sethxVault,
      lendingContract,
      lendingOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        ...setup.roles,
      },
    },
    "70",
    "Grant LendingContract and LendingOrderBook protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage71(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "70");
  assertStageNotCompleted(existing, "71");

  const priceManager = requireAddress(existing, "priceManager");
  const optionContract = requireAddress(existing, "optionContract");
  const marginOptionContract = requireAddress(existing, "marginOptionContract");
  const binaryMarginOptionContract = requireAddress(
    existing,
    "binaryMarginOptionContract",
  );

  const deployment = await deployOptionsValuationAdapter(ethers, {
    addresses: {
      priceManager,
      optionContract,
      marginOptionContract,
      binaryMarginOptionContract,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "71",
    "Deploy OptionsValuationAdapter",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage72(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "71");
  assertStageNotCompleted(existing, "72");

  const futuresContract = requireAddress(existing, "futuresContract");
  const sethxVault = requireAddress(existing, "sethxVault");

  const deployment = await deployFuturesValuationAdapter(ethers, {
    addresses: {
      futuresContract,
      sethxVault,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "72",
    "Deploy FuturesValuationAdapter",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage73(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "72");
  assertStageNotCompleted(existing, "73");

  const priceManager = requireAddress(existing, "priceManager");
  const lendingContract = requireAddress(existing, "lendingContract");
  const sethxVault = requireAddress(existing, "sethxVault");

  const deployment = await deployValuationModule(ethers, {
    addresses: {
      priceManager,
      lendingContract,
      sethxVault,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "73",
    "Deploy ValuationModule",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage74(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "73");
  assertStageNotCompleted(existing, "74");

  const valuationModule = requireAddress(existing, "valuationModule");

  const deployment = await deployRiskModule(ethers, {
    addresses: {
      valuationModule,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "74",
    "Deploy RiskModule",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage75(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "74");
  assertStageNotCompleted(existing, "75");

  const priceManager = requireAddress(existing, "priceManager");
  const lendingContract = requireAddress(existing, "lendingContract");
  const lendingOrderBook = requireAddress(existing, "lendingOrderBook");
  const optionsValuationAdapter = requireAddress(
    existing,
    "optionsValuationAdapter",
  );
  const futuresValuationAdapter = requireAddress(
    existing,
    "futuresValuationAdapter",
  );
  const valuationModule = requireAddress(existing, "valuationModule");
  const riskModule = requireAddress(existing, "riskModule");

  const setup = await setupLendingRisk(ethers, {
    addresses: {
      ...(existing.addresses ?? {}),
      priceManager,
      lendingContract,
      lendingOrderBook,
      optionsValuationAdapter,
      futuresValuationAdapter,
      valuationModule,
      riskModule,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        lendingRisk: setup.risk,
      },
    },
    "75",
    "Configure lending valuation adapters and RiskModule approvals",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage76(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "75");
  assertStageNotCompleted(existing, "76");

  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const lendingContract = requireAddress(existing, "lendingContract");
  const lendingOrderBook = requireAddress(existing, "lendingOrderBook");
  const valuationModule = requireAddress(existing, "valuationModule");

  const deployment = await deployLiquidationEngine(ethers, {
    addresses: {
      sethxVault,
      accountRegistry,
      lendingContract,
      lendingOrderBook,
      valuationModule,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "76",
    "Deploy LiquidationEngine",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage77(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "76");
  assertStageNotCompleted(existing, "77");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");

  const deployment = await deployAccountFactory(ethers, {
    addresses: {
      accountRegistry,
      sethxVault,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "77",
    "Deploy AccountFactory",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage78(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "77");
  assertStageNotCompleted(existing, "78");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");
  const liquidationEngine = requireAddress(existing, "liquidationEngine");

  const deployment = await deployLendingAccountFactory(ethers, {
    addresses: {
      accountRegistry,
      sethxVault,
      liquidationEngine,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "78",
    "Deploy LendingAccountFactory",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage79(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "78");
  assertStageNotCompleted(existing, "79");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");
  const lendingContract = requireAddress(existing, "lendingContract");
  const lendingOrderBook = requireAddress(existing, "lendingOrderBook");
  const riskModule = requireAddress(existing, "riskModule");
  const liquidationEngine = requireAddress(existing, "liquidationEngine");
  const accountFactory = requireAddress(existing, "accountFactory");
  const lendingAccountFactory = requireAddress(
    existing,
    "lendingAccountFactory",
  );

  const setup = await setupAccountFactories(ethers, {
    addresses: {
      accountRegistry,
      sethxVault,
      lendingContract,
      lendingOrderBook,
      riskModule,
      liquidationEngine,
      accountFactory,
      lendingAccountFactory,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        accountFactories: setup.accountFactories,
      },
    },
    "79",
    "Configure account factories and liquidation protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage80(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "79");
  assertStageNotCompleted(existing, "80");

  const treasuryAuthority = requireAddress(existing, "treasuryAuthority");
  const protocolTreasury = requireAddress(existing, "protocolTreasury");

  const deployment = await deployTreasuryPaymentsModule(ethers, {
    addresses: {
      treasuryAuthority,
      protocolTreasury,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "80",
    "Deploy TreasuryPaymentsModule",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage81(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "80");
  assertStageNotCompleted(existing, "81");

  const treasuryAuthority = requireAddress(existing, "treasuryAuthority");
  const sethxVault = requireAddress(existing, "sethxVault");

  const deployment = await deployTreasuryVaultModule(ethers, {
    addresses: {
      treasuryAuthority,
      sethxVault,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "81",
    "Deploy TreasuryVaultModule",
  );

  writeDeploymentOutput(config.outputDir, output);
}
async function runStage82(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "81");
  assertStageNotCompleted(existing, "82");

  const treasuryAuthority = requireAddress(existing, "treasuryAuthority");
  const protocolTreasury = requireAddress(existing, "protocolTreasury");
  const accountFactory = requireAddress(existing, "accountFactory");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");
  const futuresContract = requireAddress(existing, "futuresContract");

  const deployment = await deployTreasuryTradeModule(ethers, {
    addresses: {
      treasuryAuthority,
      protocolTreasury,
      accountFactory,
      accountRegistry,
      sethxVault,
      futuresContract,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "82",
    "Deploy TreasuryTradeModule and TreasuryFuturesMaintenanceModule",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage83(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "82");
  assertStageNotCompleted(existing, "83");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const sethxVault = requireAddress(existing, "sethxVault");
  const protocolTreasury = requireAddress(existing, "protocolTreasury");
  const treasuryAuthority = requireAddress(existing, "treasuryAuthority");
  const sethxToken = requireAddress(existing, "sethxToken");
  const treasuryPaymentsModule = requireAddress(
    existing,
    "treasuryPaymentsModule",
  );
  const treasuryVaultModule = requireAddress(existing, "treasuryVaultModule");
  const treasuryTradeModule = requireAddress(existing, "treasuryTradeModule");
  const treasuryFuturesMaintenanceModule = requireAddress(
    existing,
    "treasuryFuturesMaintenanceModule",
  );

  const setup = await setupTreasuryModules(ethers, {
    addresses: {
      accountRegistry,
      sethxVault,
      protocolTreasury,
      treasuryAuthority,
      treasuryPaymentsModule,
      treasuryVaultModule,
      treasuryTradeModule,
      treasuryFuturesMaintenanceModule,
      sethxToken,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        treasuryModules: setup.treasuryModules,
      },
    },
    "83",
    "Configure treasury module protocol roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage84(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "83");
  assertStageNotCompleted(existing, "84");

  const feeConversionDeployment = await deploySethxFeeConversionOracle(ethers);
  const tokenEthOracleDeployment = await deployTokenEthOracles(
    ethers,
    config,
    INITIAL_PROTOCOL_PARAMETERS,
  );

  const mergedDeployment = {
    ...existing,
    addresses: {
      ...(existing.addresses ?? {}),
      ...feeConversionDeployment.addresses,
      ...tokenEthOracleDeployment.addresses,
    },
    oracle: {
      ...(typeof existing.oracle === "object" && existing.oracle !== null
        ? existing.oracle
        : {}),
      ...feeConversionDeployment.oracle,
      ...tokenEthOracleDeployment.oracle,
    },
  };

  const feeConversionSetup = await setupSethxFeeConversionOracle(ethers, {
    addresses: {
      priceManager: requireAddress(mergedDeployment, "priceManager"),
      sethxToken: requireAddress(mergedDeployment, "sethxToken"),
      sethxFeeConversionOracle: requireAddress(
        mergedDeployment,
        "sethxFeeConversionOracle",
      ),
    },
  });

  const tokenEthOracleSetup = await setupTokenEthOracles(ethers, {
    addresses: {
      priceManager: requireAddress(mergedDeployment, "priceManager"),
      usdcToken: requireAddress(mergedDeployment, "usdcToken"),
      usdcEthOracle: requireAddress(mergedDeployment, "usdcEthOracle"),
    },
  });

  const output = markStageComplete(
    {
      ...mergedDeployment,
      oracle: {
        ...(typeof mergedDeployment.oracle === "object" &&
        mergedDeployment.oracle !== null
          ? mergedDeployment.oracle
          : {}),
        sethxFeeConversionOracle: feeConversionSetup.sethxFeeConversionOracle,
        tokenEthOracles: tokenEthOracleSetup.tokenEthOracles,
      },
    },
    "84",
    "Deploy and register SethxFeeConversionOracle plus USDC/ETH Chainlink-compatible oracle",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage85(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "84");
  assertStageNotCompleted(existing, "85");

  const treasuryAuthority = requireAddress(existing, "treasuryAuthority");
  const futuresOrderBook = requireAddress(existing, "futuresOrderBook");

  const deployment = await deployPassiveFuturesSnapshotPublisher(ethers, {
    addresses: {
      treasuryAuthority,
      futuresOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "85",
    "Deploy PassiveFuturesSnapshotPublisher",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage86(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "85");
  assertStageNotCompleted(existing, "86");

  const futuresContract = requireAddress(existing, "futuresContract");
  const sethxVault = requireAddress(existing, "sethxVault");
  const accountRegistry = requireAddress(existing, "accountRegistry");
  const futuresOrderBook = requireAddress(existing, "futuresOrderBook");

  const deployment = await deployPassiveFuturesPoolFactory(ethers, {
    addresses: {
      futuresContract,
      sethxVault,
      accountRegistry,
      futuresOrderBook,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      addresses: {
        ...(existing.addresses ?? {}),
        ...deployment.addresses,
      },
    },
    "86",
    "Deploy PassiveFuturesPoolFactory",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage87(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "86");
  assertStageNotCompleted(existing, "87");

  const accountRegistry = requireAddress(existing, "accountRegistry");
  const futuresOrderBook = requireAddress(existing, "futuresOrderBook");
  const passiveFuturesSnapshotPublisher = requireAddress(
    existing,
    "passiveFuturesSnapshotPublisher",
  );
  const passiveFuturesPoolFactory = requireAddress(
    existing,
    "passiveFuturesPoolFactory",
  );

  const setup = await setupPassiveFutures(ethers, {
    addresses: {
      accountRegistry,
      futuresOrderBook,
      passiveFuturesSnapshotPublisher,
      passiveFuturesPoolFactory,
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        passiveFutures: setup.passiveFutures,
      },
    },
    "87",
    "Configure passive futures publisher and pool factory roles",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage88(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "87");
  assertStageNotCompleted(existing, "88");

  const setup = await setupGovernanceAdminHandoff(ethers, {
    addresses: {
      ...existing.addresses,
      sethxTimelock: requireAddress(existing, "sethxTimelock"),
      sethxGovernor: requireAddress(existing, "sethxGovernor"),
      accountRegistry: requireAddress(existing, "accountRegistry"),
      sethxVault: requireAddress(existing, "sethxVault"),
      priceManager: requireAddress(existing, "priceManager"),
      feeManager: requireAddress(existing, "feeManager"),
      treasuryAuthority: requireAddress(existing, "treasuryAuthority"),
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        governanceAdminHandoff: setup.governanceAdminHandoff,
      },
    },
    "88",
    "Grant protocol admin and governor roles to Timelock",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function runStage89(ethers: any, config: DeploymentConfig) {
  await assertExpectedChainId(ethers, config);

  const existing = readDeploymentOutput(config.outputDir);

  assertStageCompleted(existing, "88");
  assertStageNotCompleted(existing, "89");

  const setup = await revokeBootstrapAdmin(ethers, {
    addresses: {
      // Core governance / protocol addresses: mandatory.
      sethxTimelock: requireAddress(existing, "sethxTimelock"),
      sethxGovernor: requireAddress(existing, "sethxGovernor"),
      accountRegistry: requireAddress(existing, "accountRegistry"),
      sethxVault: requireAddress(existing, "sethxVault"),
      priceManager: requireAddress(existing, "priceManager"),
      feeManager: requireAddress(existing, "feeManager"),
      sethxToken: requireAddress(existing, "sethxToken"),
      treasuryAuthority: requireAddress(existing, "treasuryAuthority"),
      protocolTreasury: requireAddress(existing, "protocolTreasury"),

      // Spot modules.
      tokenSpotOrderBook: optionalAddress(existing, "tokenSpotOrderBook"),
      nftSpotOrderBook: optionalAddress(existing, "nftSpotOrderBook"),

      // Options modules.
      optionContract: optionalAddress(existing, "optionContract"),
      optionsOrderBook: optionalAddress(existing, "optionsOrderBook"),

      binaryMarginOptionContract: optionalAddress(
        existing,
        "binaryMarginOptionContract",
      ),
      binaryMarginOptionsOrderBook: optionalAddress(
        existing,
        "binaryMarginOptionsOrderBook",
      ),

      marginOptionContract: optionalAddress(existing, "marginOptionContract"),
      marginOptionsOrderBook: optionalAddress(
        existing,
        "marginOptionsOrderBook",
      ),

      // Futures modules.
      futuresContract: optionalAddress(existing, "futuresContract"),
      futuresPositionStore: optionalAddress(existing, "futuresPositionStore"),
      futuresOrderBook: optionalAddress(existing, "futuresOrderBook"),

      // Lending / risk / liquidation modules.
      lendingContract: optionalAddress(existing, "lendingContract"),
      lendingOrderBook: optionalAddress(existing, "lendingOrderBook"),
      valuationModule: optionalAddress(existing, "valuationModule"),
      riskModule: optionalAddress(existing, "riskModule"),
      liquidationEngine: optionalAddress(existing, "liquidationEngine"),

      // Account factories.
      accountFactory: optionalAddress(existing, "accountFactory"),
      lendingAccountFactory: optionalAddress(existing, "lendingAccountFactory"),

      // Treasury modules.
      treasuryPaymentsModule: optionalAddress(
        existing,
        "treasuryPaymentsModule",
      ),
      treasuryVaultModule: optionalAddress(existing, "treasuryVaultModule"),
      treasuryTradeModule: optionalAddress(existing, "treasuryTradeModule"),
      treasuryFuturesMaintenanceModule: optionalAddress(
        existing,
        "treasuryFuturesMaintenanceModule",
      ),

      // Passive futures modules.
      passiveFuturesPoolFactory: optionalAddress(
        existing,
        "passiveFuturesPoolFactory",
      ),
      passiveFuturesSnapshotPublisher: optionalAddress(
        existing,
        "passiveFuturesSnapshotPublisher",
      ),

      // Oracles.
      sethxFeeConversionOracle: optionalAddress(
        existing,
        "sethxFeeConversionOracle",
      ),
      usdcEthOracle: optionalAddress(existing, "usdcEthOracle"),
      wbtcEthOracle: optionalAddress(existing, "wbtcEthOracle"),
    },
  });

  const output = markStageComplete(
    {
      ...existing,
      roles: {
        ...(existing.roles ?? {}),
        revokeBootstrapAdmin: setup.bootstrapAdminRevocation,
      },
    },
    "89",
    "Revoke deployer bootstrap admin and governor roles after Timelock handoff",
  );

  writeDeploymentOutput(config.outputDir, output);
}

async function main() {
  const config = getDeploymentConfig();
  const stage = getRequestedStage();
  const { ethers } = await network.connect();

  if (stage === "00") {
    await runStage00(ethers, config);
    return;
  }

  if (stage === "10") {
    await runStage10(ethers, config);
    return;
  }

  if (stage === "20") {
    await runStage20(ethers, config);
    return;
  }

  if (stage === "21") {
    await runStage21(ethers, config);
    return;
  }
  if (stage === "30") {
    await runStage30(ethers, config);
    return;
  }
  if (stage === "40") {
    await runStage40(ethers, config);
    return;
  }

  if (stage === "41") {
    await runStage41(ethers, config);
    return;
  }

  if (stage === "42") {
    await runStage42(ethers, config);
    return;
  }

  if (stage === "50") {
    await runStage50(ethers, config);
    return;
  }

  if (stage === "51") {
    await runStage51(ethers, config);
    return;
  }

  if (stage === "52") {
    await runStage52(ethers, config);
    return;
  }

  if (stage === "53") {
    await runStage53(ethers, config);
    return;
  }

  if (stage === "54") {
    await runStage54(ethers, config);
    return;
  }

  if (stage === "55") {
    await runStage55(ethers, config);
    return;
  }

  if (stage === "56") {
    await runStage56(ethers, config);
    return;
  }

  if (stage === "57") {
    await runStage57(ethers, config);
    return;
  }

  if (stage === "58") {
    await runStage58(ethers, config);
    return;
  }

  if (stage === "59") {
    await runStage59(ethers, config);
    return;
  }

  if (stage === "60") {
    await runStage60(ethers, config);
    return;
  }

  if (stage === "61") {
    await runStage61(ethers, config);
    return;
  }

  if (stage === "62") {
    await runStage62(ethers, config);
    return;
  }

  if (stage === "63") {
    await runStage63(ethers, config);
    return;
  }

  if (stage === "64") {
    await runStage64(ethers, config);
    return;
  }

  if (stage === "65") {
    await runStage65(ethers, config);
    return;
  }

  if (stage === "68") {
    await runStage68(ethers, config);
    return;
  }

  if (stage === "69") {
    await runStage69(ethers, config);
    return;
  }

  if (stage === "70") {
    await runStage70(ethers, config);
    return;
  }

  if (stage === "71") {
    await runStage71(ethers, config);
    return;
  }

  if (stage === "72") {
    await runStage72(ethers, config);
    return;
  }

  if (stage === "73") {
    await runStage73(ethers, config);
    return;
  }

  if (stage === "74") {
    await runStage74(ethers, config);
    return;
  }

  if (stage === "75") {
    await runStage75(ethers, config);
    return;
  }

  if (stage === "76") {
    await runStage76(ethers, config);
    return;
  }

  if (stage === "77") {
    await runStage77(ethers, config);
    return;
  }

  if (stage === "78") {
    await runStage78(ethers, config);
    return;
  }

  if (stage === "79") {
    await runStage79(ethers, config);
    return;
  }

  if (stage === "80") {
    await runStage80(ethers, config);
    return;
  }

  if (stage === "81") {
    await runStage81(ethers, config);
    return;
  }

  if (stage === "82") {
    await runStage82(ethers, config);
    return;
  }

  if (stage === "83") {
    await runStage83(ethers, config);
    return;
  }

  if (stage === "84") {
    await runStage84(ethers, config);
    return;
  }

  if (stage === "85") {
    await runStage85(ethers, config);
    return;
  }

  if (stage === "86") {
    await runStage86(ethers, config);
    return;
  }

  if (stage === "87") {
    await runStage87(ethers, config);
    return;
  }

  if (stage === "88") {
    await runStage88(ethers, config);
    return;
  }

  if (stage === "89") {
    await runStage89(ethers, config);
    return;
  }

  const exhaustiveCheck: never = stage;
  throw new Error(`Unsupported stage: ${exhaustiveCheck}`);
}

await main();
