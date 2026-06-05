import fs from "node:fs";
import path from "node:path";

export interface LocalDeploymentOutput {
  environment: "local";
  chainId: string;
  deployedAt: string;
  updatedAt?: string;
  founderAddress?: string;
  founderAddresses?: string[];
  founderReleaseTime?: string;

  addresses: {
    sethxToken: string;
    founderTokenTimelock?: string;
    founderTokenTimelocks?: {
      id: string;
      founderIndex: number;
      beneficiary: string;
      releaseDelaySeconds: string;
      releaseTime: string;
      allocationBps: string;
      allocation: string;
      address: string;
    }[];
    treasuryAuthority: string;
    protocolTreasury: string;

    // Governance
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

    sethxFeeConversionOracle?: string;
    passiveFuturesSnapshotPublisher?: string;
    passiveFuturesPoolFactory?: string;
  };

  tokenDistribution: {
    totalSupply: string;
    founderAmount: string;
    founderTimelockTotal?: string;
    founderTimelocks?: {
      address: string;
      allocation: string;
    }[];
    treasuryAmount: string;
  };

  governance?: {
    timelockDelaySeconds: string;
    votingDelayBlocks: string;
    votingPeriodBlocks: string;
    proposalThreshold: string;
    quorumBps: string;
  };

  roles?: {
    timelock?: {
      defaultAdminRole: string;
      proposerRole: string;
      executorRole: string;
      cancellerRole: string;
      governor: string;
      openExecutor: string;
      deployerAdminRevoked: boolean;
      deployerAdminRevocationStage?: string;
    };
  };

  stages?: Record<
    string,
    {
      completedAt: string;
      description: string;
    }
  >;
}

export function readLocalDeployment(): LocalDeploymentOutput {
  const deploymentPath = path.join(
    process.cwd(),
    "deployments",
    "local",
    "latest.json",
  );

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "Missing deployments/local/latest.json. Run the staged local deployment before running local integration tests.",
    );
  }

  return JSON.parse(
    fs.readFileSync(deploymentPath, "utf8"),
  ) as LocalDeploymentOutput;
}

export function requireLocalAddress(
  deployment: LocalDeploymentOutput,
  name: keyof LocalDeploymentOutput["addresses"],
): string {
  const address = deployment.addresses[name];

  if (typeof address !== "string" || address.length === 0) {
    throw new Error(`Missing deployment address: ${String(name)}`);
  }

  return address;
}
