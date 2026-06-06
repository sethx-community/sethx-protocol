import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";

const BTC_ETH_ORACLE = getAddress("0x973890649625573475dba1f54c16a453d7161028");
const WBTC = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");

const CONTEXTS = {
  GENERAL: 0,
  TRADE_VALUE: 1,
  FUTURE_SETTLEMENT: 2,
  COLLATERAL_EVAL: 3,
  OPTION_SETTLEMENT: 4,
} as const;

function latestDeploymentPath() {
  return path.join(process.cwd(), "deployments", "mainnet", "latest.json");
}

function outputPath() {
  return path.join(
    process.cwd(),
    "deployments",
    "mainnet",
    "chainlink-eth-oracles.json",
  );
}

function readJson(filePath: string): any {
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, "utf8").trim();

  if (raw === "") return {};

  return JSON.parse(raw);
}

function writeJson(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    )}\n`,
  );
}

function requireAddress(deployment: any, key: string): string {
  const value = deployment?.addresses?.[key];

  if (!value || typeof value !== "string") {
    throw new Error(`Missing deployment address: ${key}`);
  }

  return getAddress(value);
}

async function wait(tx: any, label: string) {
  console.log(`${label} tx:`, tx.hash);
  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} failed`);
  }

  console.log(`${label} mined in block:`, receipt.blockNumber);
  return receipt;
}

async function main() {
  const { ethers } = await network.connect("mainnet");

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 1n) {
    throw new Error(
      `Wrong chain. Expected mainnet chainId 1, got ${chain.chainId}`,
    );
  }

  const latest = readJson(latestDeploymentPath());
  const priceManagerAddress = requireAddress(latest, "priceManager");

  const priceManager = await ethers.getContractAt(
    "PriceManager",
    priceManagerAddress,
  );
  const oracle = await ethers.getContractAt(
    "ChainlinkDirectEthPairOracle",
    BTC_ETH_ORACLE,
  );

  const [signer] = await ethers.getSigners();

  console.log("Network: mainnet");
  console.log("Signer:", await signer.getAddress());
  console.log("PriceManager:", priceManagerAddress);
  console.log("BTC/ETH oracle:", BTC_ETH_ORACLE);
  console.log("WBTC token:", WBTC);

  console.log("");
  console.log("Verifying oracle before configuration...");

  const decimals = await oracle.decimals();
  const feedDecimals = await oracle.feedDecimals();
  const formula = await oracle.fetchFormula();

  console.log("decimals:", decimals.toString());
  console.log("feedDecimals:", feedDecimals.toString());
  console.log("formula:", formula);

  try {
    const metadata = await oracle.getMetadata();
    console.log("metadata:", metadata);
  } catch {
    console.log("metadata: not available on this oracle ABI");
  }

  try {
    const lastPriceBefore = await oracle.getLastPrice();
    console.log("lastPrice before:", lastPriceBefore);
  } catch {
    console.log("lastPrice before: not available before first fetch");
  }

  console.log("");
  console.log("Approving oracle...");
  await wait(
    await priceManager.approveOracle(BTC_ETH_ORACLE),
    "approveOracle(BTC/ETH)",
  );

  console.log("");
  console.log("Configuring PriceManager metadata...");
  await wait(
    await priceManager.setOracleMetadata(
      BTC_ETH_ORACLE,
      WBTC,
      "BTC/ETH",
      "BTC priced in ETH via Chainlink direct BTC/ETH feed",
    ),
    "setOracleMetadata(BTC/ETH)",
  );

  for (const context of Object.values(CONTEXTS)) {
    await wait(
      await priceManager.approveOracleForContext(BTC_ETH_ORACLE, context),
      `approveOracleForContext(BTC/ETH,${context})`,
    );
  }

  console.log("");
  console.log("Whitelisting/registering WBTC contexts...");

  for (const context of Object.values(CONTEXTS)) {
    await wait(
      await priceManager.setTokenAllowedForContext(WBTC, context, true),
      `setTokenAllowedForContext(WBTC,${context})`,
    );

    await wait(
      await priceManager.registerOracleForTokenContext(
        WBTC,
        context,
        BTC_ETH_ORACLE,
      ),
      `registerOracleForTokenContext(WBTC,${context})`,
    );
  }

  console.log("");
  console.log("Fetching oracle price...");
  await wait(await oracle.fetchPrice(), "oracle.fetchPrice(BTC/ETH)");

  console.log("Syncing oracle data into PriceManager...");
  await wait(
    await priceManager.syncOracleData(BTC_ETH_ORACLE),
    "syncOracleData(BTC/ETH)",
  );

  const lastPrice = await oracle.getLastPrice();

  console.log("");
  console.log("BTC/ETH last price:", lastPrice);

  const existing = fs.existsSync(outputPath()) ? readJson(outputPath()) : {};
  const deployed = {
    ...(existing.deployed ?? {}),
    "BTC/ETH": {
      pairName: "BTC/ETH",
      symbol: "BTC",
      tokenSymbol: "WBTC",
      feedType: "ASSET_ETH",
      feed: "0xdeb288F737066589598e9214E782fa5A8eD689e8",
      ethUsdFeed: null,
      oracle: BTC_ETH_ORACLE,
      token: WBTC,
      configuredAt: new Date().toISOString(),
      lastPrice: {
        price: lastPrice[0].toString(),
        priceTimestamp: lastPrice[1].toString(),
        lastFetchTimestamp: lastPrice[2].toString(),
        status: lastPrice[3],
      },
    },
  };

  writeJson(outputPath(), {
    updatedAt: new Date().toISOString(),
    deployed,
  });

  writeJson(latestDeploymentPath(), {
    ...latest,
    oracle: {
      ...(typeof latest.oracle === "object" && latest.oracle !== null
        ? latest.oracle
        : {}),
      chainlinkEthOracles: deployed,
    },
    updatedAt: new Date().toISOString(),
  });

  console.log("");
  console.log("Done. BTC/ETH configured and synced.");
  console.log("Output:", outputPath());
}

await main();
