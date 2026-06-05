import { safeDeployContract } from "./safe-deploy-contract.js";

import { getAddress } from "ethers";

const LOCAL_USDC_ETH_PRICE_E18 = 250_000_000_000_000n; // 0.00025 ETH per USDC

export async function deployTokenEthOracles(
  ethers: any,
  config: {
    environment: "local" | "testnet" | "mainnet";
  },
  parameters: {
    oracleDefaults: {
      staleTimeoutSeconds: number;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const maxStaleness = parameters.oracleDefaults.staleTimeoutSeconds;

  let usdcTokenAddress: string;
  let usdcEthFeedAddress: string;
  let usdcEthMockFeedInitialPriceE18: string | undefined;

  if (config.environment === "local") {
    const usdcToken = await safeDeployContract(ethers, "MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    usdcTokenAddress = await usdcToken.getAddress();

    const usdcEthFeed = await safeDeployContract(
      ethers,
      "MockChainlinkAggregatorV3",
      [18, LOCAL_USDC_ETH_PRICE_E18],
    );
    usdcEthFeedAddress = await usdcEthFeed.getAddress();

    usdcEthMockFeedInitialPriceE18 = LOCAL_USDC_ETH_PRICE_E18.toString();
  } else {
    usdcTokenAddress = getAddress(requireEnv("SETHX_USDC_TOKEN_ADDRESS"));
    usdcEthFeedAddress = getAddress(requireEnv("SETHX_USDC_ETH_FEED_ADDRESS"));
  }

  const usdcEthOracle = await safeDeployContract(
    ethers,
    "ChainlinkUsdcEthOracle",
    [deployerAddress, usdcEthFeedAddress, maxStaleness],
  );

  return {
    addresses: {
      usdcToken: usdcTokenAddress,
      usdcEthFeed: usdcEthFeedAddress,
      usdcEthOracle: await usdcEthOracle.getAddress(),
    },
    oracle: {
      tokenEthOracles: {
        usdcEth: {
          token: usdcTokenAddress,
          feed: usdcEthFeedAddress,
          oracle: await usdcEthOracle.getAddress(),
          maxStaleness: maxStaleness.toString(),
          mockFeedInitialPriceE18: usdcEthMockFeedInitialPriceE18,
        },
      },
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}
