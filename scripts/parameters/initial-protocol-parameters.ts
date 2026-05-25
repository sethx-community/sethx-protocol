export const INITIAL_PROTOCOL_PARAMETERS = {
  token: {
    totalSupplyWholeTokens: 1_000_000_000n,
    founderAllocationBps: 2_000n,
    founderLockSeconds: 2n * 365n * 24n * 60n * 60n,
  },

  governance: {
    // Filled when we add Governor.
    // Keep here, not in local/testnet/mainnet, unless a value is truly network-specific.
    quorumNumeratorBps: 400n,
    proposalThresholdWholeTokens: 100_000n,
    votingDelayBlocks: 7_200n,
    votingPeriodBlocks: 50_400n,
  },

  treasury: {
    // Filled as we add treasury roles/modules.
  },

  fees: {
    // Filled when we add FeeManager.
  },

  oracles: {
    // Filled when we add PriceManager/oracles.
  },

  markets: {
    // Filled when we add markets.
  },
} as const;
