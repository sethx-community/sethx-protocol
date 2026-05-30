import { getAddress } from "ethers";

const LOCAL_USDC_ETH_PRICE_E18 = 250_000_000_000_000n; // 0.00025 ETH per USDC
const LOCAL_WBTC_ETH_PRICE_E18 = 25n * 10n ** 18n; // 25 ETH per WBTC

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
  let wbtcTokenAddress: string;
  let usdcEthFeedAddress: string;
  let wbtcEthFeedAddress: string;
  let usdcEthMockFeedInitialPriceE18: string | undefined;
  let wbtcEthMockFeedInitialPriceE18: string | undefined;

  if (config.environment === "local") {
    const usdcToken = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    await usdcToken.waitForDeployment();
    usdcTokenAddress = await usdcToken.getAddress();

    const wbtcToken = await ethers.deployContract("MockERC20", ["Wrapped Bitcoin", "WBTC", 8]);
    await wbtcToken.waitForDeployment();
    wbtcTokenAddress = await wbtcToken.getAddress();

    const usdcEthFeed = await ethers.deployContract("MockChainlinkAggregatorV3", [
      18,
      LOCAL_USDC_ETH_PRICE_E18,
    ]);
    await usdcEthFeed.waitForDeployment();
    usdcEthFeedAddress = await usdcEthFeed.getAddress();

    const wbtcEthFeed = await ethers.deployContract("MockChainlinkAggregatorV3", [
      18,
      LOCAL_WBTC_ETH_PRICE_E18,
    ]);
    await wbtcEthFeed.waitForDeployment();
    wbtcEthFeedAddress = await wbtcEthFeed.getAddress();

    usdcEthMockFeedInitialPriceE18 = LOCAL_USDC_ETH_PRICE_E18.toString();
    wbtcEthMockFeedInitialPriceE18 = LOCAL_WBTC_ETH_PRICE_E18.toString();
  } else {
    usdcTokenAddress = getAddress(requireEnv("SETHX_USDC_TOKEN_ADDRESS"));
    wbtcTokenAddress = getAddress(requireEnv("SETHX_WBTC_TOKEN_ADDRESS"));
    usdcEthFeedAddress = getAddress(requireEnv("SETHX_USDC_ETH_FEED_ADDRESS"));
    wbtcEthFeedAddress = getAddress(requireEnv("SETHX_WBTC_ETH_FEED_ADDRESS"));
  }

  const usdcEthOracle = await ethers.deployContract("ChainlinkUsdcEthOracle", [
    deployerAddress,
    usdcEthFeedAddress,
    maxStaleness,
  ]);
  await usdcEthOracle.waitForDeployment();

  const wbtcEthOracle = await ethers.deployContract("ChainlinkWbtcEthOracle", [
    deployerAddress,
    wbtcEthFeedAddress,
    maxStaleness,
  ]);
  await wbtcEthOracle.waitForDeployment();

  return {
    addresses: {
      usdcToken: usdcTokenAddress,
      wbtcToken: wbtcTokenAddress,
      usdcEthFeed: usdcEthFeedAddress,
      wbtcEthFeed: wbtcEthFeedAddress,
      usdcEthOracle: await usdcEthOracle.getAddress(),
      wbtcEthOracle: await wbtcEthOracle.getAddress(),
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
        wbtcEth: {
          token: wbtcTokenAddress,
          feed: wbtcEthFeedAddress,
          oracle: await wbtcEthOracle.getAddress(),
          maxStaleness: maxStaleness.toString(),
          mockFeedInitialPriceE18: wbtcEthMockFeedInitialPriceE18,
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
