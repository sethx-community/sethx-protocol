import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;
const PRICE_DECIMALS = 8n;
const BPS = 10_000n;

const OptionType = { Call: 0, Put: 1 } as const;
const OptionIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;
const MarginOptionType = { Call: 0, Put: 1 } as const;
const MarginIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;
const BinaryIntent = {
  BuyOption: 0,
  SellOption: 1,
  WriteOption: 2,
  SellWriter: 3,
} as const;
const OracleContext = {
  GENERAL: 0,
  TRADE_VALUE: 1,
  FUTURE_SETTLEMENT: 2,
  COLLATERAL_EVAL: 3,
  OPTION_SETTLEMENT: 4,
  FEE_CONVERSION: 5,
} as const;

const USDC_ETH_PRICE = 250_000_000_000_000n; // 0.00025 ETH per USDC, 18 decimals
const WBTC_ETH_PRICE = 25n * ONE; // 25 ETH per WBTC, 18 decimals
const FUTURES_MARGIN_BPS = 1_000n;
const FUTURES_MAINTENANCE_BPS = 500n;
const FUTURES_MULTIPLIER = 1n;
const FUTURES_SIZE = 10n ** 15n;
const LENDING_RISK_LEVEL = 2;
const LENDING_RATE_BPS = 1_000n;

const REPORT_PATH = path.join(process.cwd(), "frontend-seed-report.json");

const TOKEN_ETH_ORACLE_CONTEXTS = [
  OracleContext.GENERAL,
  OracleContext.TRADE_VALUE,
  OracleContext.FUTURE_SETTLEMENT,
  OracleContext.COLLATERAL_EVAL,
  OracleContext.OPTION_SETTLEMENT,
] as const;

const TOKEN_ETH_ORACLE_CONFIGS = [
  {
    oracleKey: "usdcEthOracle",
    tokenKey: "usdcToken",
    label: "USDC/ETH Chainlink oracle",
    description:
      "Immutable Chainlink-compatible USDC/ETH oracle. Returns ETH per 1 USDC, normalized to 18 decimals.",
  },
  {
    oracleKey: "wbtcEthOracle",
    tokenKey: "wbtcToken",
    label: "WBTC/ETH Chainlink oracle",
    description:
      "Immutable Chainlink-compatible WBTC/ETH oracle. Returns ETH per 1 WBTC/BTC, normalized to 18 decimals.",
  },
] as const;

async function signerForAddress(signers: any[], address: string, fallbackIndex: number): Promise<any> {
  const normalized = ethers.getAddress(address);
  for (const signer of signers) {
    if (ethers.getAddress(await signer.getAddress()) === normalized) return signer;
  }

  const fallback = signers[fallbackIndex];
  if (!fallback) throw new Error(`Configured treasurer ${normalized} is not available as a local signer.`);
  return fallback;
}

function sameAddress(left: string, right: string): boolean {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function includesAddress(addresses: string[], target: string): boolean {
  return addresses.some((address) => sameAddress(address, target));
}

type TxLike = { wait: () => Promise<any> };

type SeedReport = {
  createdAt: string;
  network: string;
  addresses: Record<string, string>;
  signers: Record<string, string>;
  assets: Record<string, string>;
  oracles: Record<string, string>;
  accounts: Record<string, string[]>;
  markets: Record<string, any>;
  orderRanges: Record<string, any>;
  treasury: Record<string, any>;
  skipped: string[];
};

function deploymentPath() {
  return path.join(process.cwd(), "deployments", "local", "latest.json");
}

function readDeployment() {
  const file = deploymentPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      "deployments/local/latest.json not found. Run npm run deploy:local:all:fresh first.",
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}


function optionalAddress(deployment: any, key: string): string | undefined {
  const value = deployment.addresses?.[key];
  if (!value || value === ETH) return undefined;
  return value;
}

function requireAddress(deployment: any, key: string): string {
  const value = optionalAddress(deployment, key);
  if (!value) throw new Error(`Missing deployed address: ${key}`);
  return value;
}


async function getContracts(deployment: any) {
  const addresses = {
    sethxToken: requireAddress(deployment, "sethxToken"),
    protocolTreasury: requireAddress(deployment, "protocolTreasury"),
    treasuryAuthority: requireAddress(deployment, "treasuryAuthority"),
    treasuryTradeModule: requireAddress(deployment, "treasuryTradeModule"),
    treasuryPaymentsModule: requireAddress(
      deployment,
      "treasuryPaymentsModule",
    ),
    treasuryVaultModule: requireAddress(deployment, "treasuryVaultModule"),
    accountRegistry: requireAddress(deployment, "accountRegistry"),
    sethxVault: requireAddress(deployment, "sethxVault"),
    accountFactory: requireAddress(deployment, "accountFactory"),
    lendingAccountFactory: requireAddress(deployment, "lendingAccountFactory"),
    priceManager: requireAddress(deployment, "priceManager"),
    feeManager: requireAddress(deployment, "feeManager"),
    usdcToken: requireAddress(deployment, "usdcToken"),
    wbtcToken: requireAddress(deployment, "wbtcToken"),
    usdcEthOracle: requireAddress(deployment, "usdcEthOracle"),
    wbtcEthOracle: requireAddress(deployment, "wbtcEthOracle"),
    tokenSpotOrderBook: requireAddress(deployment, "tokenSpotOrderBook"),
    nftSpotOrderBook: requireAddress(deployment, "nftSpotOrderBook"),
    optionContract: requireAddress(deployment, "optionContract"),
    optionsOrderBook: requireAddress(deployment, "optionsOrderBook"),
    marginOptionContract: requireAddress(deployment, "marginOptionContract"),
    marginOptionsOrderBook: requireAddress(
      deployment,
      "marginOptionsOrderBook",
    ),
    binaryMarginOptionContract: requireAddress(
      deployment,
      "binaryMarginOptionContract",
    ),
    binaryMarginOptionsOrderBook: requireAddress(
      deployment,
      "binaryMarginOptionsOrderBook",
    ),
    futuresContract: requireAddress(deployment, "futuresContract"),
    futuresOrderBook: requireAddress(deployment, "futuresOrderBook"),
    settlementManager: requireAddress(deployment, "settlementManager"),
    lendingContract: requireAddress(deployment, "lendingContract"),
    lendingOrderBook: requireAddress(deployment, "lendingOrderBook"),
    riskModule: requireAddress(deployment, "riskModule"),
    valuationModule: requireAddress(deployment, "valuationModule"),
    liquidationEngine: requireAddress(deployment, "liquidationEngine"),
    passiveFuturesSnapshotPublisher: requireAddress(
      deployment,
      "passiveFuturesSnapshotPublisher",
    ),
    passiveFuturesPoolFactory: requireAddress(
      deployment,
      "passiveFuturesPoolFactory",
    ),
    sethxTimelock: requireAddress(deployment, "sethxTimelock"),
  };

  const contracts = {
    sethxToken: await ethers.getContractAt("SethxToken", addresses.sethxToken),
    protocolTreasury: await ethers.getContractAt(
      "ProtocolTreasury",
      addresses.protocolTreasury,
    ),
    treasuryAuthority: await ethers.getContractAt(
      "TreasuryAuthority",
      addresses.treasuryAuthority,
    ),
    treasuryTradeModule: await ethers.getContractAt(
      "TreasuryTradeModule",
      addresses.treasuryTradeModule,
    ),
    treasuryPaymentsModule: await ethers.getContractAt(
      "TreasuryPaymentsModule",
      addresses.treasuryPaymentsModule,
    ),
    treasuryVaultModule: await ethers.getContractAt(
      "TreasuryVaultModule",
      addresses.treasuryVaultModule,
    ),
    accountRegistry: await ethers.getContractAt(
      "AccountRegistry",
      addresses.accountRegistry,
    ),
    vault: await ethers.getContractAt("SethxVault", addresses.sethxVault),
    accountFactory: await ethers.getContractAt(
      "AccountFactory",
      addresses.accountFactory,
    ),
    lendingAccountFactory: await ethers.getContractAt(
      "LendingAccountFactory",
      addresses.lendingAccountFactory,
    ),
    priceManager: await ethers.getContractAt(
      "PriceManager",
      addresses.priceManager,
    ),
    feeManager: await ethers.getContractAt("FeeManager", addresses.feeManager),
    usdcToken: await ethers.getContractAt("MockERC20", addresses.usdcToken),
    wbtcToken: await ethers.getContractAt("MockERC20", addresses.wbtcToken),
    usdcEthOracle: await ethers.getContractAt("ChainlinkUsdcEthOracle", addresses.usdcEthOracle),
    wbtcEthOracle: await ethers.getContractAt("ChainlinkWbtcEthOracle", addresses.wbtcEthOracle),
    tokenSpotOrderBook: await ethers.getContractAt(
      "TokenSpotOrderBook",
      addresses.tokenSpotOrderBook,
    ),
    nftSpotOrderBook: await ethers.getContractAt(
      "NFTSpotOrderBook",
      addresses.nftSpotOrderBook,
    ),
    optionContract: await ethers.getContractAt(
      "OptionContract",
      addresses.optionContract,
    ),
    optionsOrderBook: await ethers.getContractAt(
      "OptionsOrderBook",
      addresses.optionsOrderBook,
    ),
    marginOptionContract: await ethers.getContractAt(
      "MarginOptionContract",
      addresses.marginOptionContract,
    ),
    marginOptionsOrderBook: await ethers.getContractAt(
      "MarginOptionsOrderBook",
      addresses.marginOptionsOrderBook,
    ),
    binaryMarginOptionContract: await ethers.getContractAt(
      "BinaryMarginOptionContract",
      addresses.binaryMarginOptionContract,
    ),
    binaryMarginOptionsOrderBook: await ethers.getContractAt(
      "BinaryMarginOptionsOrderBook",
      addresses.binaryMarginOptionsOrderBook,
    ),
    futuresContract: await ethers.getContractAt(
      "FuturesContract",
      addresses.futuresContract,
    ),
    futuresOrderBook: await ethers.getContractAt(
      "FuturesOrderBook",
      addresses.futuresOrderBook,
    ),
    settlementManager: await ethers.getContractAt(
      "SettlementManager",
      addresses.settlementManager,
    ),
    lendingContract: await ethers.getContractAt(
      "LendingContract",
      addresses.lendingContract,
    ),
    lendingOrderBook: await ethers.getContractAt(
      "LendingOrderBook",
      addresses.lendingOrderBook,
    ),
    riskModule: await ethers.getContractAt("RiskModule", addresses.riskModule),
    valuationModule: await ethers.getContractAt(
      "ValuationModule",
      addresses.valuationModule,
    ),
    liquidationEngine: await ethers.getContractAt(
      "LiquidationEngine",
      addresses.liquidationEngine,
    ),
    passiveFuturesSnapshotPublisher: await ethers.getContractAt(
      "PassiveFuturesSnapshotPublisher",
      addresses.passiveFuturesSnapshotPublisher,
    ),
    passiveFuturesPoolFactory: await ethers.getContractAt(
      "PassiveFuturesPoolFactory",
      addresses.passiveFuturesPoolFactory,
    ),
  };

  return { addresses, contracts };
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}


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

async function advanceLocalTimeTo(timestamp: bigint): Promise<void> {
  const now = await latestTimestamp();
  if (timestamp <= now) return;

  const seconds = timestamp - now;
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function executeQueuedFeeSetup(contracts: any, governance: any): Promise<void> {
  const params = INITIAL_PROTOCOL_PARAMETERS.feeManager;
  const feeManager = contracts.feeManager.connect(governance);
  let executeAfter = 0n;

  const pendingDiscount = await contracts.feeManager.pendingSethxDiscountUpdate();
  if (toBigIntValue(pendingDiscount.executeAfter) > executeAfter) {
    executeAfter = toBigIntValue(pendingDiscount.executeAfter);
  }

  for (const context of params.contexts) {
    const pending = await contracts.feeManager.pendingRoleUpdates(context.context);
    if (toBigIntValue(pending.executeAfter) > executeAfter) {
      executeAfter = toBigIntValue(pending.executeAfter);
    }
  }

  if (executeAfter > 0n) {
    console.log("Advancing local time to execute queued fee setup...");
    await advanceLocalTimeTo(executeAfter + 1n);
  }

  const discountAfterWait = await contracts.feeManager.pendingSethxDiscountUpdate();
  if (toBigIntValue(discountAfterWait.executeAfter) > 0n) {
    await (await feeManager.executeSethxDiscountUpdate()).wait();
  }

  for (const context of params.contexts) {
    const current = await contracts.feeManager.roleFeeConfigs(context.context);
    const alreadyConfigured =
      current.configured === true &&
      toBigIntValue(current.makerFixedFee) === context.makerFixedFeeEth &&
      toBigIntValue(current.makerPercentageFee) === BigInt(context.makerPercentageFeeBps) &&
      toBigIntValue(current.takerFixedFee) === context.takerFixedFeeEth &&
      toBigIntValue(current.takerPercentageFee) === BigInt(context.takerPercentageFeeBps);

    if (alreadyConfigured) continue;

    const pending = await contracts.feeManager.pendingRoleUpdates(context.context);
    if (toBigIntValue(pending.executeAfter) > 0n) {
      await (await feeManager.executeRoleFeeUpdate(context.context)).wait();
    }
  }
}

async function freshOrderExpiry(
  seconds = 20n * 24n * 60n * 60n,
): Promise<bigint> {
  return (await latestTimestamp()) + seconds;
}

async function orderExpiryBefore(marketExpiry: bigint): Promise<bigint> {
  const now = await latestTimestamp();
  const desired = now + 3n * 24n * 60n * 60n;
  const latestAllowed = marketExpiry - 600n;
  if (latestAllowed <= now + 60n)
    throw new Error(`market expiry too soon: ${marketExpiry}`);
  return desired < latestAllowed ? desired : latestAllowed;
}

function lastFridayAtNoonUtc(year: number, monthOneBased: number): bigint {
  const firstNextMonth =
    monthOneBased === 12
      ? Date.UTC(year + 1, 0, 1)
      : Date.UTC(year, monthOneBased, 1);
  const d = new Date(firstNextMonth - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

async function nextMonthlyExpiry(
  monthsAhead = 3,
  minDays = 45n,
): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);
  for (let i = monthsAhead; i < monthsAhead + 24; i++) {
    const candidateDate = new Date(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1),
    );
    const candidate = lastFridayAtNoonUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
    );
    if (candidate > now + minDays * 86_400n) return candidate;
  }
  throw new Error("no future standardized expiry found");
}

function normalizeFuturesPrice(rawPrice: bigint): bigint {
  return rawPrice;
}

function futuresMargin(size: bigint, rawPrice = WBTC_ETH_PRICE): bigint {
  return (
    (size *
      FUTURES_MULTIPLIER *
      normalizeFuturesPrice(rawPrice) *
      FUTURES_MARGIN_BPS) /
    (BPS * ONE)
  );
}

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  return (baseAmount * price) / ONE;
}

function premiumFor(size: bigint, premiumPerUnit: bigint): bigint {
  return (size * premiumPerUnit) / ONE;
}

async function impersonate(address: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000",
  ]); // 1000 ETH
  return ethers.getSigner(address);
}

async function tx(
  label: string,
  action: () => Promise<TxLike>,
  report: SeedReport,
  critical = true,
) {
  try {
    const submitted = await action();
    const receipt = await submitted.wait();
    console.log(`ok  ${label} gas=${receipt?.gasUsed?.toString?.() ?? "?"}`);
    return receipt;
  } catch (err: any) {
    const msg = `${label}: ${err?.shortMessage ?? err?.message ?? String(err)}`;
    console.warn(`skip ${msg}`);
    report.skipped.push(msg);
    if (critical) throw err;
    return undefined;
  }
}

async function deployAssets() {
  // Extra frontend-only assets. These are intentionally not whitelisted in PriceManager,
  // so spot trading can still show non-oracle/non-whitelisted token pairs.
  const tokenA = await ethers.deployContract("MockERC20", [
    "Frontend Asset A",
    "fA",
    18,
  ]);
  const tokenB = await ethers.deployContract("MockERC20", [
    "Frontend Asset B",
    "fB",
    18,
  ]);
  const tokenC = await ethers.deployContract("MockERC20", [
    "Frontend Asset C",
    "fC",
    18,
  ]);
  const nft = await ethers.deployContract("MockERC721", [
    "Frontend NFT",
    "fNFT",
  ]);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await tokenC.waitForDeployment();
  await nft.waitForDeployment();
  return { tokenA, tokenB, tokenC, nft };
}

async function mintAssets(assets: any, recipients: string[]) {
  for (const recipient of recipients) {
    await (
      await assets.tokenA.mint(recipient, ethers.parseEther("1000000"))
    ).wait();
    await (
      await assets.tokenB.mint(recipient, ethers.parseEther("1000000"))
    ).wait();
    await (
      await assets.tokenC.mint(recipient, ethers.parseEther("1000000"))
    ).wait();
    if (assets.usdcToken?.mint) {
      await (await assets.usdcToken.mint(recipient, ethers.parseUnits("1000000", 6))).wait();
    }
    if (assets.wbtcToken?.mint) {
      await (await assets.wbtcToken.mint(recipient, ethers.parseUnits("100", 8))).wait();
    }
    for (let i = 0; i < 8; i++) await (await assets.nft.mint(recipient)).wait();
  }
}

async function createNormalAccount(contracts: any, owner: any) {
  await (await contracts.accountFactory.connect(owner).createAccount()).wait();
  const accountAddress = await contracts.accountRegistry.latestNormalAccount(
    await owner.getAddress(),
  );
  return ethers.getContractAt("Account", accountAddress);
}

async function createLendingAccount(contracts: any, owner: any) {
  await (
    await contracts.lendingAccountFactory.connect(owner).createLendingAccount()
  ).wait();
  const accountAddress = await contracts.accountRegistry.latestLendingAccount(
    await owner.getAddress(),
  );
  return ethers.getContractAt("LendingAccount", accountAddress);
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH(await account.getAddress(), await account.vault(), { value: amount })).wait();
}

async function depositToken(
  token: any,
  account: any,
  owner: any,
  amount: bigint,
) {
  await (
    await token.connect(owner).approve(await account.getAddress(), amount)
  ).wait();
  await (
    await account.connect(owner).depositToken(await token.getAddress(), amount, await account.getAddress(), await account.vault())
  ).wait();
}

async function mintAndDepositNft(nft: any, account: any, owner: any) {
  const tokenId = await nft.nextTokenId();
  await (await nft.mint(await owner.getAddress())).wait();
  await (
    await nft.connect(owner).setApprovalForAll(await account.getAddress(), true)
  ).wait();
  await (
    await account.connect(owner).depositNFT721(await nft.getAddress(), tokenId, await account.getAddress(), await account.vault())
  ).wait();
  return tokenId;
}


async function refreshLocalMockTokenEthFeeds(
  contracts: any,
  addresses: Record<string, string>,
  report: SeedReport,
): Promise<void> {
  const localFeedConfigs = [
    {
      oracleKey: "usdcEthOracle",
      label: "USDC/ETH mock feed",
      answer: USDC_ETH_PRICE,
    },
    {
      oracleKey: "wbtcEthOracle",
      label: "WBTC/ETH mock feed",
      answer: WBTC_ETH_PRICE,
    },
  ] as const;

  for (const config of localFeedConfigs) {
    const oracleAddress = addresses[config.oracleKey];
    if (!oracleAddress) continue;

    try {
      const oracle = await ethers.getContractAt(
        ["function feed() view returns (address)"],
        oracleAddress,
      );
      const feedAddress = await oracle.feed();
      const feedCode = await ethers.provider.getCode(feedAddress);
      if (feedCode === "0x") continue;

      const feed = await ethers.getContractAt(
        ["function setAnswer(int256 answer)"],
        feedAddress,
      );
      await tx(
        `refresh ${config.label} timestamp`,
        () => feed.setAnswer(config.answer),
        report,
        false,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `skip refresh ${config.label}: ${message}`;
      report.skipped.push(reason);
      console.log(reason);
    }
  }
}

async function ensureTokenEthOracleSetup(
  contracts: any,
  addresses: Record<string, string>,
  governance: any,
  report: SeedReport,
) {
  for (const config of TOKEN_ETH_ORACLE_CONFIGS) {
    const oracleAddress = addresses[config.oracleKey];
    const tokenAddress = addresses[config.tokenKey];

    if (!oracleAddress || !tokenAddress) {
      throw new Error(`Missing ${config.oracleKey} or ${config.tokenKey}`);
    }

    if (!(await contracts.priceManager.isApprovedOracle(oracleAddress))) {
      await tx(
        `approve oracle ${config.label}`,
        () => contracts.priceManager.connect(governance).approveOracle(oracleAddress),
        report,
      );
    }

    const metadata = await contracts.priceManager.getOracleMetadata(oracleAddress);
    if (
      !sameAddress(metadata.token, tokenAddress) ||
      metadata.label !== config.label ||
      metadata.description !== config.description
    ) {
      await tx(
        `set oracle metadata ${config.label}`,
        () =>
          contracts.priceManager
            .connect(governance)
            .setOracleMetadata(
              oracleAddress,
              tokenAddress,
              config.label,
              config.description,
            ),
        report,
      );
    }

    for (const context of TOKEN_ETH_ORACLE_CONTEXTS) {
      if (!(await contracts.priceManager.isOracleApprovedFor(oracleAddress, context))) {
        await tx(
          `approve oracle ${config.label} context ${context}`,
          () =>
            contracts.priceManager
              .connect(governance)
              .approveOracleForContext(oracleAddress, context),
          report,
        );
      }

      if (!(await contracts.priceManager.tokenAllowedForContext(tokenAddress, context))) {
        await tx(
          `allow token ${config.tokenKey} context ${context}`,
          () =>
            contracts.priceManager
              .connect(governance)
              .setTokenAllowedForContext(tokenAddress, context, true),
          report,
        );
      }

      const registered = await contracts.priceManager.getOraclesForTokenContext(
        tokenAddress,
        context,
      );
      if (!includesAddress(registered, oracleAddress)) {
        await tx(
          `register oracle ${config.label} token context ${context}`,
          () =>
            contracts.priceManager
              .connect(governance)
              .registerOracleForTokenContext(tokenAddress, context, oracleAddress),
          report,
        );
      }
    }

    await tx(
      `fetch oracle price ${config.label}`,
      () => contracts.priceManager.fetchPrice(oracleAddress),
      report,
    );
    await tx(
      `sync oracle price ${config.label}`,
      () => contracts.priceManager.syncOracleData(oracleAddress),
      report,
    );

    const usableForFutures = await contracts.priceManager.isOracleUsableForFutures(
      oracleAddress,
    );
    if (!usableForFutures) {
      throw new Error(
        `${config.label} is still not usable for futures after setup. Check latest price timestamp/status and PriceManager staleTimeout.`,
      );
    }
  }
}

async function getOraclePrice(oracleAddress: string): Promise<bigint> {
  const oracle = await ethers.getContractAt(
    [
      "function getLastPrice() view returns (uint256 price, uint256 timestamp, uint256 lastFetchTimestamp, string status)",
      "function fetchPrice()",
    ],
    oracleAddress,
  );
  let [price] = await oracle.getLastPrice();

  if (price === 0n) {
    await (await oracle.fetchPrice()).wait();
    [price] = await oracle.getLastPrice();
  }

  if (price === 0n) {
    throw new Error(`Oracle ${oracleAddress} has no price after fetchPrice()`);
  }

  return price;
}

async function createFuturesMarket(
  contracts: any,
  governance: any,
  label: string,
  oracleAddress: string,
  report: SeedReport,
) {
  const initialPrice = await getOraclePrice(oracleAddress);
  const marketKey =
    await contracts.futuresContract.computeMarketKey(oracleAddress);
  await tx(
    `create futures market ${label}`,
    () =>
      contracts.futuresContract
        .connect(governance)
        .createMarket(
          label,
          oracleAddress,
          FUTURES_MARGIN_BPS,
          FUTURES_MAINTENANCE_BPS,
          FUTURES_MULTIPLIER,
          initialPrice,
        ),
    report,
  );
  report.markets[label] = {
    type: "futures",
    marketKey,
    oracle: oracleAddress,
    initialPrice: initialPrice.toString(),
  };
  return { marketKey, oracleAddress, initialPrice };
}

async function createMarginMarket(
  contracts: any,
  governance: any,
  label: string,
  oracleAddress: string,
  strikePrice: bigint,
  report: SeedReport,
) {
  const expiry = await nextMonthlyExpiry(3, 45n);
  await tx(
    `create margin option market ${label}`,
    () =>
      contracts.marginOptionContract
        .connect(governance)
        .createMarket(
          label,
          MarginOptionType.Call,
          oracleAddress,
          strikePrice,
          expiry,
          10_000n,
        ),
    report,
  );
  const count = await contracts.marginOptionContract.marketCount();
  const marketKey = await contracts.marginOptionContract.marketKeyAt(
    count - 1n,
  );
  report.markets[label] = {
    type: "marginOption",
    marketKey,
    expiry: expiry.toString(),
    oracle: oracleAddress,
    strikePrice: strikePrice.toString(),
  };
  return { marketKey, expiry };
}

async function createBinaryMarket(
  contracts: any,
  governance: any,
  label: string,
  oracleAddress: string,
  strikePrice: bigint,
  report: SeedReport,
) {
  const expiry = await nextMonthlyExpiry(4, 60n);
  await tx(
    `create binary margin option market ${label}`,
    () =>
      contracts.binaryMarginOptionContract
        .connect(governance)
        .createMarket(
          label,
          MarginOptionType.Call,
          oracleAddress,
          strikePrice,
          expiry,
        ),
    report,
  );
  const count = await contracts.binaryMarginOptionContract.marketCount();
  const marketKey = await contracts.binaryMarginOptionContract.marketKeyAt(
    count - 1n,
  );
  report.markets[label] = {
    type: "binaryMarginOption",
    marketKey,
    expiry: expiry.toString(),
    oracle: oracleAddress,
    strikePrice: strikePrice.toString(),
  };
  return { marketKey, expiry };
}

async function createPassivePool(
  contracts: any,
  governance: any,
  marketKey: string,
  report: SeedReport,
) {
  const snapshotPublisherAddress =
    await contracts.passiveFuturesSnapshotPublisher.getAddress();

  await tx(
    "create passive futures pool",
    () =>
      contracts.passiveFuturesPoolFactory
        .connect(governance)
        .createPool(marketKey, snapshotPublisherAddress),
    report,
    false,
  );

  const info =
    await contracts.passiveFuturesPoolFactory.poolForMarket(marketKey);
  const poolAddress = info.pool ?? info[0];

  if (poolAddress && poolAddress !== ETH) {
    report.markets.passivePool = {
      type: "passivePool",
      pool: poolAddress,
      marketKey,
    };

    return ethers.getContractAt("PassiveLiquidityPool", poolAddress);
  }

  return undefined;
}

async function setupTreasury(
  contracts: any,
  addresses: any,
  governance: any,
  treasurer: any,
  token: string,
  report: SeedReport,
) {
  const treasurerAddress = await treasurer.getAddress();
  const allPermissions =
    (await contracts.treasuryAuthority.PERMISSION_CALL_VAULT()) |
    (await contracts.treasuryAuthority.PERMISSION_MANAGE_LIQUIDITY()) |
    (await contracts.treasuryAuthority.PERMISSION_MANAGE_PAYMENTS()) |
    (await contracts.treasuryAuthority.PERMISSION_TRADE_SETHX()) |
    (await contracts.treasuryAuthority.PERMISSION_PUBLISH_PASSIVE_QUOTES());

  if (!(await contracts.treasuryAuthority.isTreasurer(treasurerAddress))) {
    await tx(
      "appoint frontend treasurer",
      () =>
        contracts.treasuryAuthority
          .connect(governance)
          .appointTreasurer(
            treasurerAddress,
            "Frontend testing treasurer",
            allPermissions,
          ),
      report,
      false,
    );
  } else {
    await tx(
      "refresh frontend treasurer permissions",
      () =>
        contracts.treasuryAuthority
          .connect(governance)
          .setTreasurerPermissions(treasurerAddress, allPermissions),
      report,
      false,
    );
  }

  await tx(
    "open treasury account",
    () =>
      contracts.treasuryTradeModule.connect(governance).openTreasuryAccount(),
    report,
    false,
  );
  const treasuryAccountAddress =
    await contracts.treasuryTradeModule.latestTreasuryAccount();
  const treasuryAccount = await ethers.getContractAt(
    "Account",
    treasuryAccountAddress,
  );
  const actionPermissions =
    (await contracts.treasuryTradeModule.ACTION_FUND_ACCOUNT()) |
    (await contracts.treasuryTradeModule.ACTION_WITHDRAW_ACCOUNT()) |
    (await contracts.treasuryTradeModule.ACTION_SPOT_TRADE()) |
    (await contracts.treasuryTradeModule.ACTION_LEND()) |
    (await contracts.treasuryTradeModule.ACTION_PASSIVE_LP());

  await tx(
    "approve treasury account access",
    () =>
      contracts.treasuryTradeModule
        .connect(governance)
        .setTreasurerActionPermissions(treasurerAddress, actionPermissions),
    report,
    false,
  );
  await tx(
    "grant treasurer account access",
    () =>
      contracts.treasuryTradeModule
        .connect(governance)
        .setTreasurerAccountAccess(
          treasurerAddress,
          treasuryAccountAddress,
          true,
        ),
    report,
    false,
  );
  await tx(
    "approve token for treasury",
    () =>
      contracts.protocolTreasury
        .connect(governance)
        .setApprovedToken(token, true),
    report,
    false,
  );
  await tx(
    "approve trade module as treasury module",
    () =>
      contracts.protocolTreasury
        .connect(governance)
        .setApprovedTreasuryModule(addresses.treasuryTradeModule, true),
    report,
    false,
  );
  await tx(
    "approve treasury account as internal receiver",
    () =>
      contracts.protocolTreasury
        .connect(governance)
        .setApprovedInternalReceiver(addresses.treasuryTradeModule, true),
    report,
    false,
  );
  await tx(
    "fund protocol treasury ETH",
    () =>
      treasurer.sendTransaction({
        to: addresses.protocolTreasury,
        value: ethers.parseEther("250"),
      }),
    report,
    false,
  );

  report.treasury.account = treasuryAccountAddress;
  report.treasury.treasurer = treasurerAddress;
  return treasuryAccount;
}

async function seedTokenSpot(
  contracts: any,
  assets: any,
  makers: any[],
  takers: any[],
  makerOwners: any[],
  takerOwners: any[],
  report: SeedReport,
) {
  const base = await assets.tokenA.getAddress();
  const quote = await assets.tokenB.getAddress();
  const startAsk = await contracts.tokenSpotOrderBook.nextOrderId();
  const amount = ethers.parseEther("100");
  for (let i = 0; i < 20; i++) {
    const makerIndex = i % makers.length;
    const account = makers[makerIndex];
    const owner = makerOwners[makerIndex];
    const price = ethers.parseEther((1.0 + i * 0.01).toFixed(2));
    await depositToken(
      assets.tokenA,
      account,
      owner,
      amount + ethers.parseEther("5"),
    );
    await depositEth(account, owner, ethers.parseEther("0.25"));
    await (
      await account
        .connect(owner)
        .placeOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          ETH,
          base,
          quote,
          1,
          price,
          amount,
          0,
        )
    ).wait();
  }
  const startBid = await contracts.tokenSpotOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const takerIndex = i % takers.length;
    const account = takers[takerIndex];
    const owner = takerOwners[takerIndex];
    const price = ethers.parseEther((0.99 - i * 0.01).toFixed(2));
    const bidSize = ethers.parseEther("80");
    await depositToken(
      assets.tokenB,
      account,
      owner,
      quoteFor(bidSize, ethers.parseEther("1.05")) + ethers.parseEther("200"),
    );
    await depositEth(account, owner, ethers.parseEther("0.25"));
    await (
      await account
        .connect(owner)
        .placeOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          ETH,
          base,
          quote,
          0,
          price,
          bidSize,
          0,
        )
    ).wait();
  }
  // Cross a few resting asks so the UI shows recent state changes and partially consumed depth.
  for (let i = 0; i < 5; i++) {
    const takerIndex = i % takers.length;
    const account = takers[takerIndex];
    const owner = takerOwners[takerIndex];
    await (
      await account
        .connect(owner)
        .acceptOrderTokenSpot(
          await contracts.tokenSpotOrderBook.getAddress(),
          startAsk + BigInt(i),
          ethers.parseEther("25"),
          ETH,
        )
    ).wait();
  }
  report.orderRanges.tokenSpot = {
    asks: [startAsk.toString(), (startAsk + 19n).toString()],
    bids: [startBid.toString(), (startBid + 19n).toString()],
    partialMatches: 5,
  };
}

async function seedNftSpot(
  contracts: any,
  assets: any,
  sellers: any[],
  bidders: any[],
  sellerOwners: any[],
  bidderOwners: any[],
  report: SeedReport,
) {
  const nft = await assets.nft.getAddress();
  const quote = await assets.tokenB.getAddress();
  const startAsk = await contracts.nftSpotOrderBook.nextOrderId();
  const askTokenIds: bigint[] = [];
  for (let i = 0; i < 20; i++) {
    const sellerIndex = i % sellers.length;
    const seller = sellers[sellerIndex];
    const owner = sellerOwners[sellerIndex];
    const tokenId = await mintAndDepositNft(assets.nft, seller, owner);
    askTokenIds.push(tokenId);
    await (
      await seller
        .connect(owner)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quote,
          1,
          ethers.parseEther((8 + i).toString()),
          0,
        )
    ).wait();
  }
  const startBid = await contracts.nftSpotOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const bidderIndex = i % bidders.length;
    const bidder = bidders[bidderIndex];
    const owner = bidderOwners[bidderIndex];
    const tokenId = askTokenIds[i];
    await depositToken(assets.tokenB, bidder, owner, ethers.parseEther("100"));
    await depositEth(bidder, owner, ethers.parseEther("0.25"));
    await (
      await bidder
        .connect(owner)
        .placeOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          ETH,
          nft,
          tokenId,
          quote,
          0,
          ethers.parseEther((7 + i).toString()),
          0,
        )
    ).wait();
  }
  for (let i = 0; i < 4; i++) {
    const buyerIndex = i % bidders.length;
    const buyer = bidders[buyerIndex];
    const owner = bidderOwners[buyerIndex];
    await (
      await buyer
        .connect(owner)
        .acceptOrderNFTSpot(
          await contracts.nftSpotOrderBook.getAddress(),
          startAsk + BigInt(i),
          ETH,
        )
    ).wait();
  }
  report.orderRanges.nftSpot = {
    asks: [startAsk.toString(), (startAsk + 19n).toString()],
    bids: [startBid.toString(), (startBid + 19n).toString()],
    filledAsks: 4,
    nft,
  };
}

async function seedOptions(
  contracts: any,
  assets: any,
  accounts: any[],
  owners: any[],
  report: SeedReport,
) {
  const asset = await assets.tokenA.getAddress();
  const expiry = await nextMonthlyExpiry(3, 60n);
  const strike = ethers.parseEther("1");
  const premium = ethers.parseEther("0.05");
  const size = ethers.parseEther("5");
  const start = await contracts.optionsOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const writer = accounts[i % accounts.length];
    const owner = owners[i % owners.length];
    await depositToken(assets.tokenA, writer, owner, size);
    await (
      await writer
        .connect(owner)
        .placeOrderOption(
          await contracts.optionsOrderBook.getAddress(),
          OptionType.Call,
          asset,
          ETH,
          strike,
          expiry,
          await orderExpiryBefore(expiry),
          ETH,
          OptionIntent.WriteOption,
          size,
          premium + BigInt(i) * 10n ** 15n,
        )
    ).wait();
  }
  for (let i = 0; i < 5; i++) {
    const holder = accounts[(i + 4) % accounts.length];
    const owner = owners[(i + 4) % owners.length];
    await depositEth(
      holder,
      owner,
      premiumFor(size, premium + BigInt(i) * 10n ** 15n) +
        ethers.parseEther("0.5"),
    );
    await (
      await holder
        .connect(owner)
        .acceptOrderOption(
          await contracts.optionsOrderBook.getAddress(),
          start + BigInt(i),
          size / 2n,
          ETH,
        )
    ).wait();
  }
  const marketKey = await contracts.optionContract.computeMarketKey(
    OptionType.Call,
    asset,
    ETH,
    await contracts.optionContract.normalizeStrike(strike),
    expiry,
  );
  report.markets.regularCallOption = {
    type: "regularOption",
    marketKey,
    asset,
    strike: strike.toString(),
    expiry: expiry.toString(),
  };
  report.orderRanges.options = {
    writerOrders: [start.toString(), (start + 19n).toString()],
    partialMatches: 5,
  };
}

async function seedMarginBooks(
  contracts: any,
  marketKey: string,
  expiry: bigint,
  accounts: any[],
  owners: any[],
  orderbook: any,
  placeName: string,
  acceptName: string,
  reportKey: string,
  report: SeedReport,
) {
  const size = ethers.parseEther("3");
  const price = ethers.parseEther("0.1");
  const writerFunding =
    reportKey === "marginOptions"
      ? (await contracts.marginOptionContract.getRequiredMargin(marketKey, size)) +
        ethers.parseEther("1")
      : size + ethers.parseEther("1");
  const start = await orderbook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const writer = accounts[i % accounts.length];
    const owner = owners[i % owners.length];
    await depositEth(writer, owner, writerFunding);
    await (
      await writer
        .connect(owner)
        [
          placeName
        ](await orderbook.getAddress(), marketKey, MarginIntent.WriteOption, size, price + BigInt(i) * 10n ** 15n, await orderExpiryBefore(expiry), ETH)
    ).wait();
  }
  for (let i = 0; i < 5; i++) {
    const holder = accounts[(i + 6) % accounts.length];
    const owner = owners[(i + 6) % owners.length];
    await depositEth(holder, owner, ethers.parseEther("5"));
    await (
      await holder
        .connect(owner)
        [
          acceptName
        ](await orderbook.getAddress(), start + BigInt(i), size / 2n, ETH)
    ).wait();
  }
  report.orderRanges[reportKey] = {
    writerOrders: [start.toString(), (start + 19n).toString()],
    partialMatches: 5,
  };
}

async function seedFutures(
  contracts: any,
  marketKey: string,
  accounts: any[],
  owners: any[],
  report: SeedReport,
) {
  const startShort = await contracts.futuresOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const maker = accounts[i % accounts.length];
    const owner = owners[i % owners.length];
    await depositEth(
      maker,
      owner,
      futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"),
    );
    await (
      await maker
        .connect(owner)
        .placeOrderFutures(
          await contracts.futuresOrderBook.getAddress(),
          marketKey,
          1,
          WBTC_ETH_PRICE + BigInt(i) * 10n ** 15n,
          FUTURES_SIZE,
          0,
          ETH,
        )
    ).wait();
  }
  const startLong = await contracts.futuresOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const maker = accounts[(i + 5) % accounts.length];
    const owner = owners[(i + 5) % owners.length];
    await depositEth(
      maker,
      owner,
      futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"),
    );
    await (
      await maker
        .connect(owner)
        .placeOrderFutures(
          await contracts.futuresOrderBook.getAddress(),
          marketKey,
          0,
          WBTC_ETH_PRICE - BigInt(i) * 10n ** 15n,
          FUTURES_SIZE,
          0,
          ETH,
        )
    ).wait();
  }
  for (let i = 0; i < 5; i++) {
    const taker = accounts[(i + 10) % accounts.length];
    const owner = owners[(i + 10) % owners.length];
    await depositEth(
      taker,
      owner,
      futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"),
    );
    await (
      await taker
        .connect(owner)
        .placeOrderFutures(
          await contracts.futuresOrderBook.getAddress(),
          marketKey,
          0,
          WBTC_ETH_PRICE + BigInt(i) * 10n ** 15n,
          FUTURES_SIZE / 2n,
          0,
          ETH,
        )
    ).wait();
  }
  report.orderRanges.futures = {
    shortOrders: [startShort.toString(), (startShort + 19n).toString()],
    longOrders: [startLong.toString(), (startLong + 19n).toString()],
    partialMatches: 5,
  };
}

async function seedLending(
  contracts: any,
  normalAccounts: any[],
  lendingAccounts: any[],
  normalOwners: any[],
  lendingOwners: any[],
  report: SeedReport,
) {
  const expiry = await nextMonthlyExpiry(4, 75n);
  const principal = ethers.parseEther("1");
  const startLend = await contracts.lendingOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const lender = normalAccounts[i % normalAccounts.length];
    const owner = normalOwners[i % normalOwners.length];
    await depositEth(lender, owner, principal + ethers.parseEther("0.5"));
    await (
      await lender
        .connect(owner)
        .placeLendOrder(
          await contracts.lendingOrderBook.getAddress(),
          ETH,
          expiry,
          LENDING_RISK_LEVEL,
          LENDING_RATE_BPS + BigInt(i * 10),
          principal,
          await orderExpiryBefore(expiry),
        )
    ).wait();
  }
  const startBorrow = await contracts.lendingOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const borrower = lendingAccounts[i % lendingAccounts.length];
    const owner = lendingOwners[i % lendingOwners.length];
    await depositEth(borrower, owner, principal * 3n);
    await (
      await borrower
        .connect(owner)
        .placeBorrowOrder(
          await contracts.lendingOrderBook.getAddress(),
          ETH,
          expiry,
          LENDING_RISK_LEVEL,
          principal,
          LENDING_RATE_BPS + BigInt(i * 10),
          await orderExpiryBefore(expiry),
        )
    ).wait();
  }
  report.markets.lendingDepth = {
    type: "lending",
    borrowToken: ETH,
    expiry: expiry.toString(),
    riskLevel: LENDING_RISK_LEVEL,
  };
  report.orderRanges.lending = {
    lendOrders: [startLend.toString(), (startLend + 19n).toString()],
    borrowOrders: [startBorrow.toString(), (startBorrow + 19n).toString()],
  };
}

async function main() {
  const deployment = readDeployment();
  const { addresses, contracts } = await getContracts(deployment);
  const signers = await ethers.getSigners();
  const [
    deployer,
    alice,
    bob,
    carol,
    dave,
    ,
    attacker,
    lp1,
    lp2,
    user9,
    user10,
    user11,
  ] = signers;
  const treasurer = await signerForAddress(
    signers,
    INITIAL_PROTOCOL_PARAMETERS.treasury.initialTreasurer,
    5,
  );
  const governance = await impersonate(addresses.sethxTimelock);

  const report: SeedReport = {
    createdAt: new Date().toISOString(),
    network: "localhost",
    addresses,
    signers: {},
    assets: {},
    oracles: {},
    accounts: { normal: [], lending: [] },
    markets: {},
    orderRanges: {},
    treasury: {},
    skipped: [],
  };

  const owners = [
    alice,
    bob,
    carol,
    dave,
    lp1,
    lp2,
    user9,
    user10,
    user11,
  ].filter(Boolean);
  for (let i = 0; i < signers.length; i++)
    report.signers[`signer${i}`] = await signers[i].getAddress();

  console.log("Deploying frontend mock assets...");
  const extraAssets = await deployAssets();
  const assets = {
    ...extraAssets,
    usdcToken: contracts.usdcToken,
    wbtcToken: contracts.wbtcToken,
  };
  report.assets = {
    tokenA: await assets.tokenA.getAddress(),
    tokenB: await assets.tokenB.getAddress(),
    tokenC: await assets.tokenC.getAddress(),
    nft: await assets.nft.getAddress(),
    usdcToken: addresses.usdcToken,
    wbtcToken: addresses.wbtcToken,
  };
  report.oracles = {
    usdcEthOracle: addresses.usdcEthOracle,
    wbtcEthOracle: addresses.wbtcEthOracle,
  };
  await mintAssets(
    assets,
    await Promise.all(owners.map((s) => s.getAddress())),
  );

  console.log("Creating user accounts...");
  const normalAccounts: any[] = [];
  const normalOwners: any[] = [];
  const lendingAccounts: any[] = [];
  const lendingOwners: any[] = [];
  for (let i = 0; i < 18; i++) {
    const owner = owners[i % owners.length];
    const account = await createNormalAccount(contracts, owner);
    normalAccounts.push(account);
    normalOwners.push(owner);
    report.accounts.normal.push(await account.getAddress());
  }
  for (let i = 0; i < 8; i++) {
    const owner = owners[(i + 2) % owners.length];
    const account = await createLendingAccount(contracts, owner);
    lendingAccounts.push(account);
    lendingOwners.push(owner);
    report.accounts.lending.push(await account.getAddress());
  }

  console.log("Ensuring deployed USDC/ETH and WBTC/ETH oracles are approved, whitelisted, registered, fetched, and synced...");
  await refreshLocalMockTokenEthFeeds(contracts, addresses, report);
  await ensureTokenEthOracleSetup(contracts, addresses, governance, report);

  console.log("Registering markets with deployed USDC/ETH and WBTC/ETH oracles...");
  const futures1 = await createFuturesMarket(
    contracts,
    governance,
    `WBTC-ETH-FUT-${Date.now()}`,
    addresses.wbtcEthOracle,
    report,
  );
  const futures2 = await createFuturesMarket(
    contracts,
    governance,
    `USDC-ETH-FUT-${Date.now()}`,
    addresses.usdcEthOracle,
    report,
  );
  const margin = await createMarginMarket(
    contracts,
    governance,
    `WBTC-ETH-MARGIN-${Date.now()}`,
    addresses.wbtcEthOracle,
    WBTC_ETH_PRICE,
    report,
  );
  const binary = await createBinaryMarket(
    contracts,
    governance,
    `USDC-ETH-BINARY-${Date.now()}`,
    addresses.usdcEthOracle,
    USDC_ETH_PRICE,
    report,
  );

  console.log("Configuring treasury account for frontend treasurer...");
  const treasuryAccount = await setupTreasury(
    contracts,
    addresses,
    governance,
    treasurer,
    report.assets.tokenB,
    report,
  );

  console.log("Creating passive pool and deposits...");
  const passivePool = await createPassivePool(
    contracts,
    governance,
    futures2.marketKey,
    report,
  );
  if (passivePool) {
    await tx(
      "public LP deposit to passive pool",
      () =>
        passivePool.connect(lp1).deposit({ value: ethers.parseEther("25") }),
      report,
      false,
    );
    await tx(
      "publish passive snapshot",
      () =>
        contracts.passiveFuturesSnapshotPublisher
          .connect(treasurer)
          .publishPassiveSnapshot(
            futures2.marketKey,
            futures2.initialPrice - 10n ** 12n,
            FUTURES_SIZE * 10n,
            futures2.initialPrice + 10n ** 12n,
            FUTURES_SIZE * 10n,
            100n,
            "frontend seed passive quotes",
          ),
      report,
      false,
    );
  }

  console.log("Seeding spot books...");
  await seedTokenSpot(
    contracts,
    assets,
    normalAccounts.slice(0, 8),
    normalAccounts.slice(8, 16),
    normalOwners.slice(0, 8),
    normalOwners.slice(8, 16),
    report,
  );
  await seedNftSpot(
    contracts,
    assets,
    normalAccounts.slice(0, 8),
    normalAccounts.slice(8, 16),
    normalOwners.slice(0, 8),
    normalOwners.slice(8, 16),
    report,
  );

  console.log("Seeding option books...");
  await seedOptions(contracts, assets, normalAccounts, normalOwners, report);
  await seedMarginBooks(
    contracts,
    margin.marketKey,
    margin.expiry,
    normalAccounts,
    normalOwners,
    contracts.marginOptionsOrderBook,
    "placeOrderMarginOption",
    "acceptOrderMarginOption",
    "marginOptions",
    report,
  );
  await seedMarginBooks(
    contracts,
    binary.marketKey,
    binary.expiry,
    normalAccounts,
    normalOwners,
    contracts.binaryMarginOptionsOrderBook,
    "placeOrderBinaryMarginOption",
    "acceptOrderBinaryMarginOption",
    "binaryMarginOptions",
    report,
  );

  console.log("Seeding futures and lending books...");
  await seedFutures(
    contracts,
    futures1.marketKey,
    normalAccounts,
    normalOwners,
    report,
  );
  await seedLending(
    contracts,
    normalAccounts,
    lendingAccounts,
    normalOwners,
    lendingOwners,
    report,
  );

  if (treasuryAccount) {
    const treasuryAccountAddress = await treasuryAccount.getAddress();
    const treasurySpotPrice = ethers.parseEther("0.95");
    const treasurySpotAmount = ethers.parseEther("25");
    const treasurySpotQuoteFunding =
      quoteFor(treasurySpotAmount, treasurySpotPrice) + ethers.parseEther("5");

    await tx(
      "fund treasury account with ETH",
      () =>
        contracts.treasuryTradeModule
          .connect(treasurer)
          .depositETHToAccount(treasuryAccountAddress, ethers.parseEther("50")),
      report,
      false,
    );

    await tx(
      "approve tokenA for treasury trading",
      () =>
        contracts.protocolTreasury
          .connect(governance)
          .setApprovedToken(report.assets.tokenA, true),
      report,
      false,
    );

    await tx(
      "fund protocol treasury tokenA quote",
      () => assets.tokenA.mint(addresses.protocolTreasury, treasurySpotQuoteFunding),
      report,
      false,
    );

    await tx(
      "fund treasury account with tokenA quote",
      () =>
        contracts.treasuryTradeModule
          .connect(treasurer)
          .depositERC20ToAccount(
            treasuryAccountAddress,
            report.assets.tokenA,
            treasurySpotQuoteFunding,
          ),
      report,
      false,
    );

    await tx(
      "seed treasury spot order",
      () =>
        contracts.treasuryTradeModule
          .connect(treasurer)
          .placeSpotOrder(
            treasuryAccountAddress,
            addresses.tokenSpotOrderBook,
            ETH,
            report.assets.tokenB,
            report.assets.tokenA,
            0,
            treasurySpotPrice,
            treasurySpotAmount,
            0,
          ),
      report,
      false,
    );
  }

  await executeQueuedFeeSetup(contracts, governance);

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\nFrontend exchange seed complete. Report written to ${REPORT_PATH}`,
  );
  console.log("Created accounts:", report.accounts);
  console.log("Created markets:", report.markets);
  if (report.skipped.length) {
    console.log("\nNon-critical skipped operations:");
    for (const item of report.skipped) console.log(`- ${item}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
