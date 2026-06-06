import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { getAddress, getCreateAddress, ZeroAddress, Wallet } from "ethers";

const ETH_USD_FEED = getAddress("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419");
const MAX_STALENESS = 0n;

const CONTEXTS = {
  GENERAL: 0,
  TRADE_VALUE: 1,
  FUTURE_SETTLEMENT: 2,
  COLLATERAL_EVAL: 3,
  OPTION_SETTLEMENT: 4,
  FEE_CONVERSION: 5,
} as const;

const TOKEN_ADDRESSES: Record<string, string> = {
  WBTC: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
  LINK: getAddress("0x514910771AF9Ca656af840dff83E8264EcF986CA"),
  UNI: getAddress("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"),
  AAVE: getAddress("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9"),
  LDO: getAddress("0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32"),
  DAI: getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F"),
};

type FeedType = "ASSET_ETH" | "ASSET_USD";

type OracleConfig = {
  pairName: string;
  symbol: string;
  feedType: FeedType;
  feed: string;
  tokenSymbol?: keyof typeof TOKEN_ADDRESSES;
};

const oracleConfigs: OracleConfig[] = [
  {
    pairName: "BTC/ETH",
    symbol: "BTC",
    tokenSymbol: "WBTC",
    feedType: "ASSET_ETH",
    feed: "0xdeb288F737066589598e9214E782fa5A8eD689e8",
  },
  {
    pairName: "LINK/ETH",
    symbol: "LINK",
    tokenSymbol: "LINK",
    feedType: "ASSET_ETH",
    feed: "0xDC530D9457755926550b59e8ECcdaE7624181557",
  },
  {
    pairName: "UNI/ETH",
    symbol: "UNI",
    tokenSymbol: "UNI",
    feedType: "ASSET_USD",
    feed: "0x553303d460EE0afB37EdFf9bE42922D8FF63220e",
  },
  {
    pairName: "AAVE/ETH",
    symbol: "AAVE",
    tokenSymbol: "AAVE",
    feedType: "ASSET_USD",
    feed: "0x547a514d5e3769680Ce22B2361c10Ea13619e8a9",
  },
  {
    pairName: "LDO/ETH",
    symbol: "LDO",
    tokenSymbol: "LDO",
    feedType: "ASSET_ETH",
    feed: "0x4e844125952D32AcdF339BE976c98E22F6F318dB",
  },
  {
    pairName: "DAI/ETH",
    symbol: "DAI",
    tokenSymbol: "DAI",
    feedType: "ASSET_USD",
    feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
  },
  {
    pairName: "EUR/ETH",
    symbol: "EUR",
    feedType: "ASSET_USD",
    feed: "0xb49f677943BC038e9857d61E7d053CaA2C1734C1",
  },
  {
    pairName: "GBP/ETH",
    symbol: "GBP",
    feedType: "ASSET_USD",
    feed: "0x5c0Ab2d9b5a7ed9f470386e82BB36A3613cDd4b5",
  },
  {
    pairName: "JPY/ETH",
    symbol: "JPY",
    feedType: "ASSET_USD",
    feed: "0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb3",
  },
  {
    pairName: "CHF/ETH",
    symbol: "CHF",
    feedType: "ASSET_USD",
    feed: "0x449d117117838fFA61263B61dA6301AA2a88B13A",
  },
  {
    pairName: "XAU/ETH",
    symbol: "XAU",
    feedType: "ASSET_USD",
    feed: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
  },
  {
    pairName: "XAG/ETH",
    symbol: "XAG",
    feedType: "ASSET_USD",
    feed: "0x379589227b15F1a12195D3f2d90bBc9F31f95235",
  },
];

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

async function maybeWait(txPromise: Promise<any>, label: string) {
  const tx = await txPromise;
  return wait(tx, label);
}

async function deployContractSafely(
  ethers: any,
  deployer: Wallet,
  contractName: string,
  args: any[],
): Promise<{ address: string; txHash: string }> {
  const deployerAddress = getAddress(await deployer.getAddress());

  const nonce = await ethers.provider.getTransactionCount(
    deployerAddress,
    "pending",
  );

  const predictedAddress = getAddress(
    getCreateAddress({
      from: deployerAddress,
      nonce,
    }),
  );

  const factory = await ethers.getContractFactory(contractName);

  console.log(`Predicted ${contractName} address:`, predictedAddress);

  const deployTxRequest = await factory.getDeployTransaction(...args);
  const feeData = await ethers.provider.getFeeData();
  const chain = await ethers.provider.getNetwork();

  const txRequest: any = {
    ...deployTxRequest,
    from: deployerAddress,
    nonce,
    chainId: chain.chainId,
    type: 2,
    value: deployTxRequest.value ?? 0n,
    maxFeePerGas: feeData.maxFeePerGas ?? feeData.gasPrice,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
  };

  txRequest.gasLimit =
    ((await ethers.provider.estimateGas(txRequest)) * 120n) / 100n;

  const signedTx = await deployer.signTransaction(txRequest);

  const txHash = await ethers.provider.send("eth_sendRawTransaction", [
    signedTx,
  ]);

  console.log(`${contractName} deployment tx:`, txHash);

  for (let attempt = 0; attempt < 120; attempt++) {
    const code = await ethers.provider.getCode(predictedAddress);

    if (code && code !== "0x") {
      console.log(`${contractName} deployed at:`, predictedAddress);
      return {
        address: predictedAddress,
        txHash,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(
    `${contractName} deployment tx ${txHash} was sent, but no code appeared at ${predictedAddress}`,
  );
}

async function deployOracleForConfig(
  ethers: any,
  deployer: Wallet,
  treasuryAuthorityAddress: string,
  config: OracleConfig,
): Promise<{ address: string; txHash: string }> {
  if (config.feedType === "ASSET_ETH") {
    return deployContractSafely(
      ethers,
      deployer,
      "ChainlinkDirectEthPairOracle",
      [
        treasuryAuthorityAddress,
        getAddress(config.feed),
        MAX_STALENESS,
        config.pairName,
      ],
    );
  }

  return deployContractSafely(ethers, deployer, "ChainlinkCrossRateEthOracle", [
    treasuryAuthorityAddress,
    getAddress(config.feed),
    ETH_USD_FEED,
    MAX_STALENESS,
    config.pairName,
  ]);
}

async function main() {
  const { ethers } = await network.connect("mainnet");

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 1n) {
    throw new Error(
      `Wrong chain. Expected mainnet chainId 1, got ${chain.chainId}`,
    );
  }

  const rawPrivateKey =
    process.env.PRIVATE_KEY ??
    process.env.ADMIN_PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY ??
    process.env.MAINNET_PRIVATE_KEY;

  if (!rawPrivateKey) {
    throw new Error(
      "Missing private key env var. Set PRIVATE_KEY, ADMIN_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY, or MAINNET_PRIVATE_KEY.",
    );
  }

  const rawDeployer = new Wallet(rawPrivateKey, ethers.provider);

  const rawDeployerAddress = getAddress(await rawDeployer.getAddress());
  const deployerAddress = getAddress(await rawDeployer.getAddress());

  if (rawDeployerAddress !== deployerAddress) {
    throw new Error(
      `Private key signer mismatch. Hardhat signer is ${deployerAddress}, raw signer is ${rawDeployerAddress}`,
    );
  }

  const deployment = readJson(latestDeploymentPath());

  const priceManagerAddress = requireAddress(deployment, "priceManager");
  const treasuryAuthorityAddress = requireAddress(
    deployment,
    "treasuryAuthority",
  );

  const priceManager = await ethers.getContractAt(
    "PriceManager",
    priceManagerAddress,
  );

  const existing = readJson(outputPath());

  const deployed: Record<string, any> = {
    ...(existing.deployed ?? {}),
  };

  const contextsToApprove = [
    CONTEXTS.GENERAL,
    CONTEXTS.TRADE_VALUE,
    CONTEXTS.FUTURE_SETTLEMENT,
    CONTEXTS.COLLATERAL_EVAL,
    CONTEXTS.OPTION_SETTLEMENT,
  ];

  console.log("Network: mainnet");
  console.log("Deployer:", deployerAddress);
  console.log("PriceManager:", priceManagerAddress);
  console.log("TreasuryAuthority/admin:", treasuryAuthorityAddress);
  console.log("ETH/USD denominator:", ETH_USD_FEED);
  console.log("Max staleness:", MAX_STALENESS.toString());

  for (const config of oracleConfigs) {
    console.log("");
    console.log("--------------------------------------------------");
    console.log(`Processing ${config.pairName}`);
    console.log("feed type:", config.feedType);
    console.log("feed:", config.feed);

    const existingEntry = deployed[config.pairName];

    if (existingEntry?.configuredAt && existingEntry?.lastPrice) {
      console.log(`${config.pairName} already configured. Skipping.`);
      continue;
    }

    let oracleAddress: string | undefined = existingEntry?.oracle;

    if (!oracleAddress) {
      console.log(`Deploying oracle for ${config.pairName}...`);

      const deployedOracle = await deployOracleForConfig(
        ethers,
        rawDeployer,
        treasuryAuthorityAddress,
        config,
      );

      oracleAddress = deployedOracle.address;

      deployed[config.pairName] = {
        pairName: config.pairName,
        symbol: config.symbol,
        tokenSymbol: config.tokenSymbol ?? null,
        feedType: config.feedType,
        feed: getAddress(config.feed),
        ethUsdFeed: config.feedType === "ASSET_USD" ? ETH_USD_FEED : null,
        oracle: oracleAddress,
        deploymentTx: deployedOracle.txHash,
        deployedAt: new Date().toISOString(),
      };

      writeJson(outputPath(), {
        updatedAt: new Date().toISOString(),
        deployed,
      });

      console.log(`${config.pairName} oracle deployed:`, oracleAddress);
    } else {
      oracleAddress = getAddress(oracleAddress);
      console.log(`${config.pairName} already deployed:`, oracleAddress);
    }

    const oracle = await ethers.getContractAt(
      config.feedType === "ASSET_ETH"
        ? "ChainlinkDirectEthPairOracle"
        : "ChainlinkCrossRateEthOracle",
      oracleAddress,
    );

    const tokenAddress = config.tokenSymbol
      ? TOKEN_ADDRESSES[config.tokenSymbol]
      : ZeroAddress;

    console.log("Approving oracle...");
    await maybeWait(
      priceManager.approveOracle(oracleAddress),
      `approveOracle(${config.pairName})`,
    );

    console.log("Setting oracle metadata...");
    await maybeWait(
      priceManager.setOracleMetadata(
        oracleAddress,
        tokenAddress,
        config.pairName,
        `${config.pairName} via Chainlink ${
          config.feedType === "ASSET_ETH" ? "direct ETH feed" : "USD cross-rate"
        } oracle`,
      ),
      `setOracleMetadata(${config.pairName})`,
    );

    for (const context of contextsToApprove) {
      await maybeWait(
        priceManager.approveOracleForContext(oracleAddress, context),
        `approveOracleForContext(${config.pairName},${context})`,
      );
    }

    if (tokenAddress !== ZeroAddress) {
      console.log(`Whitelisting token ${config.tokenSymbol}:`, tokenAddress);

      for (const context of contextsToApprove) {
        await maybeWait(
          priceManager.setTokenAllowedForContext(tokenAddress, context, true),
          `setTokenAllowedForContext(${config.tokenSymbol},${context})`,
        );

        await maybeWait(
          priceManager.registerOracleForTokenContext(
            tokenAddress,
            context,
            oracleAddress,
          ),
          `registerOracleForTokenContext(${config.tokenSymbol},${context})`,
        );
      }
    } else {
      console.log(
        "No ERC20 token metadata/whitelist for synthetic/non-token market.",
      );
    }

    console.log("Fetching oracle price...");
    await maybeWait(
      oracle.fetchPrice(),
      `oracle.fetchPrice(${config.pairName})`,
    );

    console.log("Syncing oracle data into PriceManager...");
    await maybeWait(
      priceManager.syncOracleData(oracleAddress),
      `syncOracleData(${config.pairName})`,
    );

    const lastPrice = await oracle.getLastPrice();
    console.log(`${config.pairName} last price:`, lastPrice);

    deployed[config.pairName] = {
      ...deployed[config.pairName],
      oracle: oracleAddress,
      token: tokenAddress === ZeroAddress ? null : tokenAddress,
      configuredAt: new Date().toISOString(),
      lastPrice: {
        price: lastPrice[0].toString(),
        priceTimestamp: lastPrice[1].toString(),
        lastFetchTimestamp: lastPrice[2].toString(),
        status: lastPrice[3],
      },
    };

    writeJson(outputPath(), {
      updatedAt: new Date().toISOString(),
      deployed,
    });
  }

  const latest = readJson(latestDeploymentPath());

  const updatedLatest = {
    ...latest,
    oracle: {
      ...(typeof latest.oracle === "object" && latest.oracle !== null
        ? latest.oracle
        : {}),
      chainlinkEthOracles: deployed,
    },
    updatedAt: new Date().toISOString(),
  };

  writeJson(latestDeploymentPath(), updatedLatest);

  console.log("");
  console.log("Done.");
  console.log("Oracle deployment output:", outputPath());
  console.log("latest.json updated:", latestDeploymentPath());
}

await main();
