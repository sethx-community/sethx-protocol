import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

function toBigIntValue(value: unknown): bigint {
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

export async function setupLendingRisk(
  ethers: any,
  deployment: {
    addresses: {
      priceManager: string;
      lendingContract: string;
      lendingOrderBook: string;
      tokenSpotOrderBook?: string;
      optionContract?: string;
      optionsOrderBook?: string;
      binaryMarginOptionContract?: string;
      binaryMarginOptionsOrderBook?: string;
      marginOptionContract?: string;
      marginOptionsOrderBook?: string;
      futuresContract?: string;
      futuresOrderBook?: string;
      optionsValuationAdapter: string;
      futuresValuationAdapter: string;
      valuationModule: string;
      riskModule: string;
    };
  },
) {
  const valuationModule = await ethers.getContractAt(
    "ValuationModule",
    deployment.addresses.valuationModule,
  );

  const riskModule = await ethers.getContractAt(
    "RiskModule",
    deployment.addresses.riskModule,
  );

  const lendingContract = await ethers.getContractAt(
    "LendingContract",
    deployment.addresses.lendingContract,
  );

  if (
    (await valuationModule.optionsView()) !==
    deployment.addresses.optionsValuationAdapter
  ) {
    const tx = await valuationModule.setOptionsView(
      deployment.addresses.optionsValuationAdapter,
    );
    await tx.wait();
  }

  if (
    (await valuationModule.futuresView()) !==
    deployment.addresses.futuresValuationAdapter
  ) {
    const tx = await valuationModule.setFuturesView(
      deployment.addresses.futuresValuationAdapter,
    );
    await tx.wait();
  }

  if (
    (await lendingContract.riskModule()) !== deployment.addresses.riskModule
  ) {
    const tx = await lendingContract.setRiskModule(
      deployment.addresses.riskModule,
    );
    await tx.wait();
  }

  const configuredValuationRiskLevels: number[] = [];

  for (const tier of INITIAL_PROTOCOL_PARAMETERS.lendingRisk.valuationTiers) {
    const currentTier = await valuationModule.riskTiers(tier.riskLevel);

    const needsUpdate =
      currentTier.enabled !== tier.enabled ||
      toBigIntValue(currentTier.maxLtvBps) !== BigInt(tier.maxLtvBps) ||
      toBigIntValue(currentTier.liquidationLtvBps) !==
        BigInt(tier.liquidationLtvBps) ||
      toBigIntValue(currentTier.longOptionHaircutBps) !==
        BigInt(tier.longOptionHaircutBps) ||
      toBigIntValue(currentTier.shortOptionHaircutBps) !==
        BigInt(tier.shortOptionHaircutBps) ||
      toBigIntValue(currentTier.bondHaircutBps) !==
        BigInt(tier.bondHaircutBps) ||
      toBigIntValue(currentTier.futuresHaircutStepBps) !==
        BigInt(tier.futuresHaircutStepBps);

    if (needsUpdate) {
      const tx = await valuationModule.setRiskTier(
        tier.riskLevel,
        tier.enabled,
        tier.maxLtvBps,
        tier.liquidationLtvBps,
        tier.longOptionHaircutBps,
        tier.shortOptionHaircutBps,
        tier.bondHaircutBps,
        tier.futuresHaircutStepBps,
      );
      await tx.wait();
    }

    configuredValuationRiskLevels.push(tier.riskLevel);
  }

  const configuredLendingRiskLevels: number[] = [];

  for (const level of INITIAL_PROTOCOL_PARAMETERS.lendingRisk
    .lendingRiskLevels) {
    const currentLevel = await lendingContract.riskLevels(level.riskLevel);

    const needsUpdate =
      currentLevel.enabled !== level.enabled ||
      toBigIntValue(currentLevel.maxLtvBps) !== BigInt(level.maxLtvBps) ||
      toBigIntValue(currentLevel.liquidationLtvBps) !==
        BigInt(level.liquidationLtvBps);

    if (needsUpdate) {
      const tx = await lendingContract.setRiskLevel(
        level.riskLevel,
        level.enabled,
        level.maxLtvBps,
        level.liquidationLtvBps,
      );
      await tx.wait();
    }

    configuredLendingRiskLevels.push(level.riskLevel);
  }

  async function callIfAddress(name: string, fn: string) {
    const target = (deployment.addresses as Record<string, string | undefined>)[
      name
    ];

    if (!target) return false;

    const tx = await (riskModule as any)[fn](target, true);
    await tx.wait();

    return true;
  }

  const approved: Record<string, boolean> = {};

  if (
    !(await riskModule.hasRole(
      await riskModule.LENDING_CONTRACT_ROLE(),
      deployment.addresses.lendingContract,
    ))
  ) {
    const tx = await riskModule.setApprovedLendingContract(
      deployment.addresses.lendingContract,
      true,
    );
    await tx.wait();
  }

  approved.lendingContract = true;

  approved.lendingOrderBook = await callIfAddress(
    "lendingOrderBook",
    "setApprovedLendingOrderBook",
  );

  approved.tokenSpotOrderBook = await callIfAddress(
    "tokenSpotOrderBook",
    "setApprovedTokenSpotOrderBook",
  );

  approved.optionsOrderBook = await callIfAddress(
    "optionsOrderBook",
    "setApprovedOptionsOrderBook",
  );

  approved.optionContract = await callIfAddress(
    "optionContract",
    "setApprovedOptionContract",
  );

  approved.futuresOrderBook = await callIfAddress(
    "futuresOrderBook",
    "setApprovedFuturesOrderBook",
  );

  approved.futuresContract = await callIfAddress(
    "futuresContract",
    "setApprovedFuturesContract",
  );

  approved.marginOptionsOrderBook = await callIfAddress(
    "marginOptionsOrderBook",
    "setApprovedMarginOptionsOrderBook",
  );

  approved.marginOptionContract = await callIfAddress(
    "marginOptionContract",
    "setApprovedMarginOptionContract",
  );

  approved.binaryMarginOptionsOrderBook = await callIfAddress(
    "binaryMarginOptionsOrderBook",
    "setApprovedBinaryMarginOptionsOrderBook",
  );

  approved.binaryMarginOptionContract = await callIfAddress(
    "binaryMarginOptionContract",
    "setApprovedBinaryMarginOptionContract",
  );

  return {
    risk: {
      valuationRiskLevels: configuredValuationRiskLevels,
      lendingRiskLevels: configuredLendingRiskLevels,
      valuationViewsConfigured: true,
      lendingRiskModuleConfigured: true,
      approved,
    },
  };
}
