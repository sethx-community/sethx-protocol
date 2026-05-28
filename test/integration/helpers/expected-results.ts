export const BPS = 10_000n;
export const WAD = 10n ** 18n;

export type FeeInput = {
  fixedFee: bigint;
  percentageFeeBps: bigint;
  notional: bigint;
};

export function expectedFee(input: FeeInput): bigint {
  return input.fixedFee + (input.notional * input.percentageFeeBps) / BPS;
}

export type SpotTradeExpected = {
  baseAmount: bigint;
  priceQuotePerBase: bigint;
  priceDecimals: bigint;
  makerFixedFee: bigint;
  makerFeeBps: bigint;
  takerFixedFee: bigint;
  takerFeeBps: bigint;
};

export function expectedSpotTrade(input: SpotTradeExpected) {
  const quoteAmount =
    (input.baseAmount * input.priceQuotePerBase) / input.priceDecimals;

  const makerFee = expectedFee({
    fixedFee: input.makerFixedFee,
    percentageFeeBps: input.makerFeeBps,
    notional: quoteAmount,
  });

  const takerFee = expectedFee({
    fixedFee: input.takerFixedFee,
    percentageFeeBps: input.takerFeeBps,
    notional: quoteAmount,
  });

  return {
    baseAmount: input.baseAmount,
    quoteAmount,
    makerFee,
    takerFee,
    totalFees: makerFee + takerFee,
  };
}

export type FuturesOpenExpected = {
  size: bigint;
  multiplier: bigint;
  priceNorm: bigint;
  marginBps: bigint;
  marginDecimals: bigint;
};

export function expectedFuturesInitialMargin(input: FuturesOpenExpected) {
  const notional =
    (input.size * input.multiplier * input.priceNorm) /
    10n ** input.marginDecimals /
    WAD;

  const margin = (notional * input.marginBps) / BPS;

  return {
    notional,
    margin,
  };
}

export type FuturesVariationExpected = {
  size: bigint;
  multiplier: bigint;
  entryPriceNorm: bigint;
  settlementPriceNorm: bigint;
  marginDecimals: bigint;
};

export function expectedFuturesVariation(input: FuturesVariationExpected) {
  const diff =
    input.entryPriceNorm > input.settlementPriceNorm
      ? input.entryPriceNorm - input.settlementPriceNorm
      : input.settlementPriceNorm - input.entryPriceNorm;

  const amount =
    (input.size * input.multiplier * diff) / 10n ** input.marginDecimals / WAD;

  return {
    amount,
    longReceives: input.settlementPriceNorm > input.entryPriceNorm,
    shortReceives: input.settlementPriceNorm < input.entryPriceNorm,
  };
}

export type LendingLtvExpected = {
  debtEth: bigint;
  collateralEth: bigint;
};

export function expectedLtvBps(input: LendingLtvExpected): bigint {
  if (input.collateralEth === 0n) {
    return input.debtEth === 0n ? 0n : BPS;
  }

  return (input.debtEth * BPS) / input.collateralEth;
}

export type LiquidationAuctionExpected = {
  debtEth: bigint;
  purchasePriceEth: bigint;
};

export function expectedLiquidationPurchase(input: LiquidationAuctionExpected) {
  if (input.purchasePriceEth >= input.debtEth) {
    return {
      debtRecovered: input.debtEth,
      surplus: input.purchasePriceEth - input.debtEth,
      loss: 0n,
    };
  }

  return {
    debtRecovered: input.purchasePriceEth,
    surplus: 0n,
    loss: input.debtEth - input.purchasePriceEth,
  };
}
