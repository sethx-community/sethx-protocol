const GENERAL_CONTEXT = 0;
const TRADE_VALUE_CONTEXT = 1;
const FUTURE_SETTLEMENT_CONTEXT = 2;
const COLLATERAL_EVAL_CONTEXT = 3;
const OPTION_SETTLEMENT_CONTEXT = 4;

const TOKEN_ETH_CONTEXTS = [
  { id: GENERAL_CONTEXT, name: "GENERAL" },
  { id: TRADE_VALUE_CONTEXT, name: "TRADE_VALUE" },
  { id: FUTURE_SETTLEMENT_CONTEXT, name: "FUTURE_SETTLEMENT" },
  { id: COLLATERAL_EVAL_CONTEXT, name: "COLLATERAL_EVAL" },
  { id: OPTION_SETTLEMENT_CONTEXT, name: "OPTION_SETTLEMENT" },
] as const;

const ORACLE_CONFIGS = [
  {
    key: "usdcEth",
    oracleAddressKey: "usdcEthOracle",
    tokenAddressKey: "usdcToken",
    label: "USDC/ETH Chainlink oracle",
    description: "Immutable Chainlink-compatible USDC/ETH oracle. Returns ETH per 1 USDC, normalized to 18 decimals.",
  },
  {
    key: "wbtcEth",
    oracleAddressKey: "wbtcEthOracle",
    tokenAddressKey: "wbtcToken",
    label: "WBTC/ETH Chainlink oracle",
    description: "Immutable Chainlink-compatible WBTC/ETH oracle. Returns ETH per 1 WBTC/BTC, normalized to 18 decimals.",
  },
] as const;

function sameAddress(ethers: any, left: string, right: string) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function includesAddress(ethers: any, addresses: string[], target: string) {
  return addresses.some((address) => sameAddress(ethers, address, target));
}

export async function setupTokenEthOracles(
  ethers: any,
  deployment: {
    addresses: Record<string, string | undefined> & {
      priceManager: string;
      usdcToken: string;
      wbtcToken: string;
      usdcEthOracle: string;
      wbtcEthOracle: string;
    };
  },
) {
  const priceManager = await ethers.getContractAt(
    "PriceManager",
    deployment.addresses.priceManager,
  );

  const setup: Record<string, unknown> = {};

  for (const oracleConfig of ORACLE_CONFIGS) {
    const oracleAddress = deployment.addresses[oracleConfig.oracleAddressKey];
    const tokenAddress = deployment.addresses[oracleConfig.tokenAddressKey];
    const actions: string[] = [];

    if (!oracleAddress) {
      throw new Error(`Missing deployment address ${oracleConfig.oracleAddressKey}`);
    }

    if (!tokenAddress) {
      throw new Error(`Missing deployment address ${oracleConfig.tokenAddressKey}`);
    }

    if (!(await priceManager.isApprovedOracle(oracleAddress))) {
      const tx = await priceManager.approveOracle(oracleAddress);
      await tx.wait();
      actions.push("approveOracle");
    }

    const metadata = await priceManager.getOracleMetadata(oracleAddress);
    if (
      !sameAddress(ethers, metadata.token, tokenAddress) ||
      metadata.label !== oracleConfig.label ||
      metadata.description !== oracleConfig.description
    ) {
      const tx = await priceManager.setOracleMetadata(
        oracleAddress,
        tokenAddress,
        oracleConfig.label,
        oracleConfig.description,
      );
      await tx.wait();
      actions.push("setOracleMetadata");
    }

    for (const context of TOKEN_ETH_CONTEXTS) {
      if (!(await priceManager.isOracleApprovedFor(oracleAddress, context.id))) {
        const tx = await priceManager.approveOracleForContext(oracleAddress, context.id);
        await tx.wait();
        actions.push(`approveOracleForContext:${context.name}`);
      }

      if (!(await priceManager.tokenAllowedForContext(tokenAddress, context.id))) {
        const tx = await priceManager.setTokenAllowedForContext(
          tokenAddress,
          context.id,
          true,
        );
        await tx.wait();
        actions.push(`setTokenAllowedForContext:${context.name}`);
      }

      const registeredOracles = await priceManager.getOraclesForTokenContext(
        tokenAddress,
        context.id,
      );
      if (!includesAddress(ethers, registeredOracles, oracleAddress)) {
        const tx = await priceManager.registerOracleForTokenContext(
          tokenAddress,
          context.id,
          oracleAddress,
        );
        await tx.wait();
        actions.push(`registerOracleForTokenContext:${context.name}`);
      }
    }

    const fetchTx = await priceManager.fetchPrice(oracleAddress);
    await fetchTx.wait();
    actions.push("fetchPrice");

    const syncTx = await priceManager.syncOracleData(oracleAddress);
    await syncTx.wait();
    actions.push("syncOracleData");

    setup[oracleConfig.key] = {
      oracle: oracleAddress,
      token: tokenAddress,
      contexts: TOKEN_ETH_CONTEXTS.map((context) => context.name),
      registeredContexts: Object.fromEntries(
        await Promise.all(
          TOKEN_ETH_CONTEXTS.map(async (context) => [
            context.name,
            await priceManager.getOraclesForTokenContext(tokenAddress, context.id),
          ]),
        ),
      ),
      actions,
    };
  }

  return {
    tokenEthOracles: setup,
  };
}
