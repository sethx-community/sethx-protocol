const WAD = 10n ** 18n;
const ETH = "ETH";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TOTAL_SUPPLY = 1_000_000_000n * WAD;
const FOUNDER_ALLOCATION = 210_000_000n * WAD;
const TREASURY_ALLOCATION = 790_000_000n * WAD;

const ONE_DAY_SECONDS = 24n * 60n * 60n;
const FOUNDER_TWO_YEAR_LOCK_SECONDS = 2n * 365n * ONE_DAY_SECONDS;
const FOUNDER_FIVE_YEAR_LOCK_SECONDS = 5n * 365n * ONE_DAY_SECONDS;

const FIXED_FEE_ETH = 100_000_000_000_000n; // 0.0001 ETH
const HOSTING_MONTHLY_LIMIT_ETH = 250_000_000_000_000_000n; // 0.25 ETH

export const INITIAL_PROTOCOL_PARAMETERS = {
  token: {
    name: "SETHX",
    symbol: "SETHX",
    decimals: 18,
    totalSupply: TOTAL_SUPPLY,
    founderAllocation: FOUNDER_ALLOCATION,
    treasuryAllocation: TREASURY_ALLOCATION,
    founderTimelocks: [
      {
        founderIndex: 0,
        releaseDelaySeconds: FOUNDER_TWO_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
      {
        founderIndex: 0,
        releaseDelaySeconds: FOUNDER_FIVE_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
      {
        founderIndex: 1,
        releaseDelaySeconds: FOUNDER_TWO_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
      {
        founderIndex: 1,
        releaseDelaySeconds: FOUNDER_FIVE_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
      {
        founderIndex: 2,
        releaseDelaySeconds: FOUNDER_TWO_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
      {
        founderIndex: 2,
        releaseDelaySeconds: FOUNDER_FIVE_YEAR_LOCK_SECONDS,
        allocationBps: 350n,
      },
    ],
  },

  governance: {
    // 0.2% quorum. Based on total token supply unless Governor logic changes.
    quorumBps: 20,

    // Production assumption: about 12 seconds per block.
    // 1 day = 86,400 seconds / 12 = 7,200 blocks.
    votingDelayBlocks: 7_200n,

    // 5 days = 432,000 seconds / 12 = 36,000 blocks.
    votingPeriodBlocks: 36_000n,

    proposalThreshold: 100_000n * WAD,
    timelockDelaySeconds: 2n * ONE_DAY_SECONDS,
  },

  feeManager: {
    feeUpdateDelaySeconds: 86_400,
    acceptEthFees: true,
    acceptSethxFees: true,
    sethxDiscountBps: 4_000,

    fixedFeeEth: FIXED_FEE_ETH,

    // Context names must exactly match the orderbook constants.
    // Maker/taker split is handled by FeeManager's isMaker flag.
    contexts: [
      {
        context: "ERC20 Spot Trade",
        makerFixedFeeEth: FIXED_FEE_ETH,
        makerPercentageFeeBps: 2,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 2,
      },
      {
        context: "ERC721 Spot Trade",
        makerFixedFeeEth: 0n,
        makerPercentageFeeBps: 0,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 4,
      },
      {
        context: "Options Trade",
        makerFixedFeeEth: FIXED_FEE_ETH,
        makerPercentageFeeBps: 1,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 2,
      },
      {
        context: "Margin Option Trade",
        makerFixedFeeEth: FIXED_FEE_ETH,
        makerPercentageFeeBps: 1,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 2,
      },
      {
        context: "Binary Option Trade",
        makerFixedFeeEth: FIXED_FEE_ETH,
        makerPercentageFeeBps: 1,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 2,
      },
      {
        context: "Futures Trade",
        makerFixedFeeEth: FIXED_FEE_ETH,
        makerPercentageFeeBps: 1,
        takerFixedFeeEth: FIXED_FEE_ETH,
        takerPercentageFeeBps: 2,
      },
    ],
  },

  sethxFeeConversionOracle: {
    sethxPerEth: 20_000n * WAD,
  },

  oracleDefaults: {
    staleTimeoutSeconds: 86_400,
  },

  options: {
    defaultExerciseWindowSeconds: 86_400,
  },

  marginOptions: {
    settlementPriceMaxWaitSeconds: 3_600,
    approvedCollateralBps: [10_000],
  },

  binaryMarginOptions: {
    settlementPriceMaxWaitSeconds: 3_600,
  },

  initialOracles: [
    {
      id: "ETH_USDC",
      pair: "ETH/USDC",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      decimals: 8,
      staleTimeoutSeconds: 3_600,
    },
    {
      id: "BTC_USDC",
      pair: "BTC/USDC",
      baseSymbol: "BTC",
      quoteSymbol: "USDC",
      decimals: 8,
      staleTimeoutSeconds: 3_600,
    },
  ],

  futures: {
    // Defaults are already set in the contracts.
    // Keep this as documentation / future governance reference.
    orderLimits: {
      maxOrdersPerBlock: 20,
      maxUnmatchedOrders: 100,
    },

    initialMarkets: [
      {
        id: "ETH_USDC_FUT",
        ticker: "ETH/USDC",
        oracleId: "ETH_USDC",
        marginDecimals: 18,
        initialMarginBps: 1_000,
        maintenanceMarginBps: 700,
        multiplier: WAD,
        minMarginPerUnitLongNorm: 0n,
        minMarginPerUnitShortNorm: 0n,
        createPassivePool: true,
      },
      {
        id: "BTC_USDC_FUT",
        ticker: "BTC/USDC",
        oracleId: "BTC_USDC",
        marginDecimals: 18,
        initialMarginBps: 1_000,
        maintenanceMarginBps: 700,
        multiplier: WAD,
        minMarginPerUnitLongNorm: 0n,
        minMarginPerUnitShortNorm: 0n,
        createPassivePool: true,
      },
    ],
  },

  lendingRisk: {
    valuationTiers: [
      {
        riskLevel: 1,
        enabled: true,
        maxLtvBps: 4_000,
        liquidationLtvBps: 6_000,
        longOptionHaircutBps: 3_000,
        shortOptionHaircutBps: 3_000,
        bondHaircutBps: 1_500,
        futuresHaircutStepBps: 1_500,
      },
      {
        riskLevel: 2,
        enabled: true,
        maxLtvBps: 6_000,
        liquidationLtvBps: 8_000,
        longOptionHaircutBps: 2_000,
        shortOptionHaircutBps: 2_000,
        bondHaircutBps: 1_000,
        futuresHaircutStepBps: 1_000,
      },
    ],

    lendingRiskLevels: [
      {
        riskLevel: 1,
        enabled: true,
        maxLtvBps: 4_000,
        liquidationLtvBps: 6_000,
      },
      {
        riskLevel: 2,
        enabled: true,
        maxLtvBps: 6_000,
        liquidationLtvBps: 8_000,
      },
    ],
  },

  liquidation: {
    premiumPhaseDuration: 3_600,
    parPhaseDuration: 3_600,
    discountPhaseDuration: 3_600,
    startPriceBps: 12_000,
    parPriceBps: 10_000,
    endPriceBps: 8_000,
  },

  treasury: {
    initialTreasurer: "0xFFb88E0a3e2fDe477107230CB412cF7c560437f1",
    initialGuardian: "0xFFb88E0a3e2fDe477107230CB412cF7c560437f1",

    paymentRecipients: [
      {
        id: "HOSTING",
        recipient: "0xFFb88E0a3e2fDe477107230CB412cF7c560437f1",
        token: ETH,
        monthlyLimit: HOSTING_MONTHLY_LIMIT_ETH,
        approved: true,
      },
    ],

    treasurerPermissions: {
      vault: true,
      liquidity: true,
      payments: true,
      trading: true,
      passiveQuotePublishing: true,
      oracleFunding: true,
    },

    tradeModuleActions: {
      fundAccount: true,
      withdrawAccount: true,
      spotTrade: true,
      lend: true,
      passiveLp: true,
    },
  },

  passiveFutures: {
    manualPublisherEnabled: true,
    createInitialPools: true,
  },
} as const;
