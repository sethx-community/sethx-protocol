import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ONE = 10n ** 18n;
const PRICE_DECIMALS = 8n;
const BPS = 10_000n;

const OptionType = { Call: 0, Put: 1 } as const;
const OptionIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const MarginOptionType = { Call: 0, Put: 1 } as const;
const MarginIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const BinaryIntent = { BuyOption: 0, SellOption: 1, WriteOption: 2, SellWriter: 3 } as const;
const OracleContext = { GENERAL: 0, TRADE_VALUE: 1, FUTURE_SETTLEMENT: 2, COLLATERAL_EVAL: 3, OPTION_SETTLEMENT: 4, FEE_CONVERSION: 5 } as const;

const FUTURES_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const FUTURES_MARGIN_BPS = 1_000n;
const FUTURES_MAINTENANCE_BPS = 500n;
const FUTURES_MULTIPLIER = 1n;
const FUTURES_SIZE = 10n ** 15n;
const LENDING_RISK_LEVEL = 2;
const LENDING_RATE_BPS = 1_000n;

const REPORT_PATH = path.join(process.cwd(), "frontend-seed-report.json");

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

function readDeployment() {
  const file = path.join(process.cwd(), "deployments", "local", "latest.json");
  if (!fs.existsSync(file)) {
    throw new Error("deployments/local/latest.json not found. Run npm run deploy:local:all:fresh first.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireAddress(deployment: any, key: string): string {
  const value = deployment.addresses?.[key];
  if (!value || value === ETH) throw new Error(`Missing deployed address: ${key}`);
  return value;
}

async function getContracts(deployment: any) {
  const addresses = {
    sethxToken: requireAddress(deployment, "sethxToken"),
    protocolTreasury: requireAddress(deployment, "protocolTreasury"),
    treasuryAuthority: requireAddress(deployment, "treasuryAuthority"),
    treasuryTradeModule: requireAddress(deployment, "treasuryTradeModule"),
    treasuryPaymentsModule: requireAddress(deployment, "treasuryPaymentsModule"),
    treasuryVaultModule: requireAddress(deployment, "treasuryVaultModule"),
    accountRegistry: requireAddress(deployment, "accountRegistry"),
    sethxVault: requireAddress(deployment, "sethxVault"),
    accountFactory: requireAddress(deployment, "accountFactory"),
    lendingAccountFactory: requireAddress(deployment, "lendingAccountFactory"),
    priceManager: requireAddress(deployment, "priceManager"),
    feeManager: requireAddress(deployment, "feeManager"),
    tokenSpotOrderBook: requireAddress(deployment, "tokenSpotOrderBook"),
    nftSpotOrderBook: requireAddress(deployment, "nftSpotOrderBook"),
    optionContract: requireAddress(deployment, "optionContract"),
    optionsOrderBook: requireAddress(deployment, "optionsOrderBook"),
    marginOptionContract: requireAddress(deployment, "marginOptionContract"),
    marginOptionsOrderBook: requireAddress(deployment, "marginOptionsOrderBook"),
    binaryMarginOptionContract: requireAddress(deployment, "binaryMarginOptionContract"),
    binaryMarginOptionsOrderBook: requireAddress(deployment, "binaryMarginOptionsOrderBook"),
    futuresContract: requireAddress(deployment, "futuresContract"),
    futuresOrderBook: requireAddress(deployment, "futuresOrderBook"),
    settlementManager: requireAddress(deployment, "settlementManager"),
    lendingContract: requireAddress(deployment, "lendingContract"),
    lendingOrderBook: requireAddress(deployment, "lendingOrderBook"),
    riskModule: requireAddress(deployment, "riskModule"),
    valuationModule: requireAddress(deployment, "valuationModule"),
    liquidationEngine: requireAddress(deployment, "liquidationEngine"),
    passiveFuturesSnapshotPublisher: requireAddress(deployment, "passiveFuturesSnapshotPublisher"),
    passiveFuturesPoolFactory: requireAddress(deployment, "passiveFuturesPoolFactory"),
    sethxTimelock: requireAddress(deployment, "sethxTimelock"),
  };

  const contracts = {
    sethxToken: await ethers.getContractAt("SethxToken", addresses.sethxToken),
    protocolTreasury: await ethers.getContractAt("ProtocolTreasury", addresses.protocolTreasury),
    treasuryAuthority: await ethers.getContractAt("TreasuryAuthority", addresses.treasuryAuthority),
    treasuryTradeModule: await ethers.getContractAt("TreasuryTradeModule", addresses.treasuryTradeModule),
    treasuryPaymentsModule: await ethers.getContractAt("TreasuryPaymentsModule", addresses.treasuryPaymentsModule),
    treasuryVaultModule: await ethers.getContractAt("TreasuryVaultModule", addresses.treasuryVaultModule),
    accountRegistry: await ethers.getContractAt("AccountRegistry", addresses.accountRegistry),
    vault: await ethers.getContractAt("SethxVault", addresses.sethxVault),
    accountFactory: await ethers.getContractAt("AccountFactory", addresses.accountFactory),
    lendingAccountFactory: await ethers.getContractAt("LendingAccountFactory", addresses.lendingAccountFactory),
    priceManager: await ethers.getContractAt("PriceManager", addresses.priceManager),
    feeManager: await ethers.getContractAt("FeeManager", addresses.feeManager),
    tokenSpotOrderBook: await ethers.getContractAt("TokenSpotOrderBook", addresses.tokenSpotOrderBook),
    nftSpotOrderBook: await ethers.getContractAt("NFTSpotOrderBook", addresses.nftSpotOrderBook),
    optionContract: await ethers.getContractAt("OptionContract", addresses.optionContract),
    optionsOrderBook: await ethers.getContractAt("OptionsOrderBook", addresses.optionsOrderBook),
    marginOptionContract: await ethers.getContractAt("MarginOptionContract", addresses.marginOptionContract),
    marginOptionsOrderBook: await ethers.getContractAt("MarginOptionsOrderBook", addresses.marginOptionsOrderBook),
    binaryMarginOptionContract: await ethers.getContractAt("BinaryMarginOptionContract", addresses.binaryMarginOptionContract),
    binaryMarginOptionsOrderBook: await ethers.getContractAt("BinaryMarginOptionsOrderBook", addresses.binaryMarginOptionsOrderBook),
    futuresContract: await ethers.getContractAt("FuturesContract", addresses.futuresContract),
    futuresOrderBook: await ethers.getContractAt("FuturesOrderBook", addresses.futuresOrderBook),
    settlementManager: await ethers.getContractAt("SettlementManager", addresses.settlementManager),
    lendingContract: await ethers.getContractAt("LendingContract", addresses.lendingContract),
    lendingOrderBook: await ethers.getContractAt("LendingOrderBook", addresses.lendingOrderBook),
    riskModule: await ethers.getContractAt("RiskModule", addresses.riskModule),
    valuationModule: await ethers.getContractAt("ValuationModule", addresses.valuationModule),
    liquidationEngine: await ethers.getContractAt("LiquidationEngine", addresses.liquidationEngine),
    passiveFuturesSnapshotPublisher: await ethers.getContractAt("PassiveFuturesSnapshotPublisher", addresses.passiveFuturesSnapshotPublisher),
    passiveFuturesPoolFactory: await ethers.getContractAt("PassiveFuturesPoolFactory", addresses.passiveFuturesPoolFactory),
  };

  return { addresses, contracts };
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block not found");
  return BigInt(block.timestamp);
}

async function freshOrderExpiry(seconds = 20n * 24n * 60n * 60n): Promise<bigint> {
  return (await latestTimestamp()) + seconds;
}

async function orderExpiryBefore(marketExpiry: bigint): Promise<bigint> {
  const now = await latestTimestamp();
  const desired = now + 3n * 24n * 60n * 60n;
  const latestAllowed = marketExpiry - 600n;
  if (latestAllowed <= now + 60n) throw new Error(`market expiry too soon: ${marketExpiry}`);
  return desired < latestAllowed ? desired : latestAllowed;
}

function lastFridayAtNoonUtc(year: number, monthOneBased: number): bigint {
  const firstNextMonth = monthOneBased === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, monthOneBased, 1);
  const d = new Date(firstNextMonth - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

async function nextMonthlyExpiry(monthsAhead = 3, minDays = 45n): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);
  for (let i = monthsAhead; i < monthsAhead + 24; i++) {
    const candidateDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1));
    const candidate = lastFridayAtNoonUtc(candidateDate.getUTCFullYear(), candidateDate.getUTCMonth() + 1);
    if (candidate > now + minDays * 86_400n) return candidate;
  }
  throw new Error("no future standardized expiry found");
}

function normalizeFuturesPrice(rawPrice: bigint): bigint {
  return rawPrice * 10n ** (18n - PRICE_DECIMALS);
}

function futuresMargin(size: bigint, rawPrice = FUTURES_PRICE): bigint {
  return (size * FUTURES_MULTIPLIER * normalizeFuturesPrice(rawPrice) * FUTURES_MARGIN_BPS) / (BPS * ONE);
}

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  return (baseAmount * price) / ONE;
}

function premiumFor(size: bigint, premiumPerUnit: bigint): bigint {
  return (size * premiumPerUnit) / ONE;
}

async function impersonate(address: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [address, "0x3635C9ADC5DEA00000"]); // 1000 ETH
  return ethers.getSigner(address);
}

async function tx(label: string, action: () => Promise<TxLike>, report: SeedReport, critical = true) {
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
  const tokenA = await ethers.deployContract("MockERC20", ["Frontend Asset A", "fA", 18]);
  const tokenB = await ethers.deployContract("MockERC20", ["Frontend Asset B", "fB", 18]);
  const tokenC = await ethers.deployContract("MockERC20", ["Frontend Asset C", "fC", 18]);
  const nft = await ethers.deployContract("MockERC721", ["Frontend NFT", "fNFT"]);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await tokenC.waitForDeployment();
  await nft.waitForDeployment();
  return { tokenA, tokenB, tokenC, nft };
}

async function mintAssets(assets: any, recipients: string[]) {
  for (const recipient of recipients) {
    await (await assets.tokenA.mint(recipient, ethers.parseEther("1000000"))).wait();
    await (await assets.tokenB.mint(recipient, ethers.parseEther("1000000"))).wait();
    await (await assets.tokenC.mint(recipient, ethers.parseEther("1000000"))).wait();
    for (let i = 0; i < 8; i++) await (await assets.nft.mint(recipient)).wait();
  }
}

async function createNormalAccount(contracts: any, owner: any) {
  await (await contracts.accountFactory.connect(owner).createAccount()).wait();
  const accountAddress = await contracts.accountRegistry.latestNormalAccount(await owner.getAddress());
  return ethers.getContractAt("Account", accountAddress);
}

async function createLendingAccount(contracts: any, owner: any) {
  await (await contracts.lendingAccountFactory.connect(owner).createLendingAccount()).wait();
  const accountAddress = await contracts.accountRegistry.latestLendingAccount(await owner.getAddress());
  return ethers.getContractAt("LendingAccount", accountAddress);
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (await account.connect(owner).depositETH({ value: amount })).wait();
}

async function depositToken(token: any, account: any, owner: any, amount: bigint) {
  await (await token.connect(owner).approve(await account.getAddress(), amount)).wait();
  await (await account.connect(owner).depositToken(await token.getAddress(), amount)).wait();
}

async function mintAndDepositNft(nft: any, account: any, owner: any) {
  const tokenId = await nft.nextTokenId();
  await (await nft.mint(await owner.getAddress())).wait();
  await (await nft.connect(owner).setApprovalForAll(await account.getAddress(), true)).wait();
  await (await account.connect(owner).depositNFT721(await nft.getAddress(), tokenId)).wait();
  return tokenId;
}

async function registerOracle(contracts: any, governance: any, pair: string, price: bigint, context: number, token = ETH) {
  const oracle = await ethers.deployContract("MockPriceOracle", [pair, 8, price]);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  await (await contracts.priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  await (await contracts.priceManager.connect(governance).approveOracleForContext(oracleAddress, context)).wait();
  if (token !== ETH) {
    await (await contracts.priceManager.connect(governance).setTokenAllowedForContext(token, context, true)).wait();
    await (await contracts.priceManager.connect(governance).registerOracleForTokenContext(token, context, oracleAddress)).wait();
  } else if (context === OracleContext.OPTION_SETTLEMENT) {
    await (await contracts.priceManager.connect(governance).setTokenAllowedForContext(token, context, true)).wait();
    await (await contracts.priceManager.connect(governance).registerOracleForTokenContext(token, context, oracleAddress)).wait();
  }
  await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
  return { oracle, oracleAddress };
}

async function createFuturesMarket(contracts: any, governance: any, label: string, report: SeedReport) {
  const { oracle, oracleAddress } = await registerOracle(contracts, governance, `${label}/USD`, FUTURES_PRICE, OracleContext.FUTURE_SETTLEMENT);
  const marketKey = await contracts.futuresContract.computeMarketKey(oracleAddress);
  await tx(`create futures market ${label}`, () => contracts.futuresContract.connect(governance).createMarket(label, oracleAddress, FUTURES_MARGIN_BPS, FUTURES_MAINTENANCE_BPS, FUTURES_MULTIPLIER, FUTURES_PRICE), report);
  report.oracles[`${label}Oracle`] = oracleAddress;
  report.markets[label] = { type: "futures", marketKey, oracle: oracleAddress };
  return { marketKey, oracle, oracleAddress };
}

async function createMarginMarket(contracts: any, governance: any, label: string, report: SeedReport) {
  const expiry = (await latestTimestamp()) + 21n * 86_400n;
  const { oracleAddress } = await registerOracle(contracts, governance, `${label}/ETH`, 2n * 10n ** 8n, OracleContext.OPTION_SETTLEMENT, ETH);
  await tx(`create margin option market ${label}`, () => contracts.marginOptionContract.connect(governance).createMarket(label, MarginOptionType.Call, oracleAddress, 2n * 10n ** 8n, 10n ** 8n, expiry, 10_000n), report);
  const count = await contracts.marginOptionContract.marketCount();
  const marketKey = await contracts.marginOptionContract.marketKeyAt(count - 1n);
  report.oracles[`${label}Oracle`] = oracleAddress;
  report.markets[label] = { type: "marginOption", marketKey, expiry: expiry.toString(), oracle: oracleAddress };
  return { marketKey, expiry };
}

async function createBinaryMarket(contracts: any, governance: any, label: string, report: SeedReport) {
  const expiry = (await latestTimestamp()) + 22n * 86_400n;
  const { oracleAddress } = await registerOracle(contracts, governance, `${label}/ETH`, 2n * 10n ** 8n, OracleContext.OPTION_SETTLEMENT, ETH);
  await tx(`create binary margin option market ${label}`, () => contracts.binaryMarginOptionContract.connect(governance).createMarket(label, MarginOptionType.Call, oracleAddress, 2n * 10n ** 8n, 10n ** 8n, expiry), report);
  const count = await contracts.binaryMarginOptionContract.marketCount();
  const marketKey = await contracts.binaryMarginOptionContract.marketKeyAt(count - 1n);
  report.oracles[`${label}Oracle`] = oracleAddress;
  report.markets[label] = { type: "binaryMarginOption", marketKey, expiry: expiry.toString(), oracle: oracleAddress };
  return { marketKey, expiry };
}

async function createPassivePool(contracts: any, governance: any, marketKey: string, report: SeedReport) {
  await tx("create passive futures pool", () => contracts.passiveFuturesPoolFactory.connect(governance).createPool(marketKey, await contracts.passiveFuturesSnapshotPublisher.getAddress()), report, false);
  const info = await contracts.passiveFuturesPoolFactory.poolForMarket(marketKey);
  const poolAddress = info.pool ?? info[0];
  if (poolAddress && poolAddress !== ETH) {
    report.markets.passivePool = { type: "passivePool", pool: poolAddress, marketKey };
    return ethers.getContractAt("PassiveLiquidityPool", poolAddress);
  }
  return undefined;
}

async function setupTreasury(contracts: any, addresses: any, governance: any, treasurer: any, token: string, report: SeedReport) {
  const treasurerAddress = await treasurer.getAddress();
  const allPermissions =
    (await contracts.treasuryAuthority.PERMISSION_CALL_VAULT()) |
    (await contracts.treasuryAuthority.PERMISSION_MANAGE_LIQUIDITY()) |
    (await contracts.treasuryAuthority.PERMISSION_MANAGE_PAYMENTS()) |
    (await contracts.treasuryAuthority.PERMISSION_TRADE_SETHX()) |
    (await contracts.treasuryAuthority.PERMISSION_PUBLISH_PASSIVE_QUOTES());

  if (!(await contracts.treasuryAuthority.isTreasurer(treasurerAddress))) {
    await tx("appoint frontend treasurer", () => contracts.treasuryAuthority.connect(governance).appointTreasurer(treasurerAddress, "Frontend testing treasurer", allPermissions), report, false);
  } else {
    await tx("refresh frontend treasurer permissions", () => contracts.treasuryAuthority.connect(governance).setTreasurerPermissions(treasurerAddress, allPermissions), report, false);
  }

  await tx("open treasury account", () => contracts.treasuryTradeModule.connect(governance).openTreasuryAccount(), report, false);
  const treasuryAccountAddress = await contracts.treasuryTradeModule.latestTreasuryAccount();
  const treasuryAccount = await ethers.getContractAt("Account", treasuryAccountAddress);
  const actionPermissions =
    (await contracts.treasuryTradeModule.ACTION_FUND_ACCOUNT()) |
    (await contracts.treasuryTradeModule.ACTION_WITHDRAW_ACCOUNT()) |
    (await contracts.treasuryTradeModule.ACTION_SPOT_TRADE()) |
    (await contracts.treasuryTradeModule.ACTION_LEND()) |
    (await contracts.treasuryTradeModule.ACTION_PASSIVE_LP());

  await tx("approve treasury account access", () => contracts.treasuryTradeModule.connect(governance).setTreasurerActionPermissions(treasurerAddress, actionPermissions), report, false);
  await tx("grant treasurer account access", () => contracts.treasuryTradeModule.connect(governance).setTreasurerAccountAccess(treasurerAddress, treasuryAccountAddress, true), report, false);
  await tx("approve token for treasury", () => contracts.protocolTreasury.connect(governance).setApprovedToken(token, true), report, false);
  await tx("approve trade module as treasury module", () => contracts.protocolTreasury.connect(governance).setApprovedTreasuryModule(addresses.treasuryTradeModule, true), report, false);
  await tx("approve treasury account as internal receiver", () => contracts.protocolTreasury.connect(governance).setApprovedInternalReceiver(addresses.treasuryTradeModule, true), report, false);
  await tx("fund protocol treasury ETH", () => treasurer.sendTransaction({ to: addresses.protocolTreasury, value: ethers.parseEther("250") }), report, false);

  report.treasury.account = treasuryAccountAddress;
  report.treasury.treasurer = treasurerAddress;
  return treasuryAccount;
}

async function seedTokenSpot(contracts: any, assets: any, makers: any[], takers: any[], owners: any[], report: SeedReport) {
  const base = await assets.tokenA.getAddress();
  const quote = await assets.tokenB.getAddress();
  const startAsk = await contracts.tokenSpotOrderBook.nextOrderId();
  const amount = ethers.parseEther("100");
  for (let i = 0; i < 20; i++) {
    const account = makers[i % makers.length];
    const owner = owners[i % owners.length];
    const price = ethers.parseEther((1.00 + i * 0.01).toFixed(2));
    await depositToken(assets.tokenA, account, owner, amount + ethers.parseEther("5"));
    await depositEth(account, owner, ethers.parseEther("0.25"));
    await (await account.connect(owner).placeOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), ETH, base, quote, 1, price, amount, 0)).wait();
  }
  const startBid = await contracts.tokenSpotOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const account = takers[i % takers.length];
    const owner = owners[(i + 3) % owners.length];
    const price = ethers.parseEther((0.99 - i * 0.01).toFixed(2));
    const bidSize = ethers.parseEther("80");
    await depositToken(assets.tokenB, account, owner, quoteFor(bidSize, ethers.parseEther("1.05")) + ethers.parseEther("200"));
    await depositEth(account, owner, ethers.parseEther("0.25"));
    await (await account.connect(owner).placeOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), ETH, base, quote, 0, price, bidSize, 0)).wait();
  }
  // Cross a few resting asks so the UI shows recent state changes and partially consumed depth.
  for (let i = 0; i < 5; i++) {
    const account = takers[i % takers.length];
    const owner = owners[(i + 3) % owners.length];
    await (await account.connect(owner).acceptOrderTokenSpot(await contracts.tokenSpotOrderBook.getAddress(), startAsk + BigInt(i), ethers.parseEther("25"), ETH)).wait();
  }
  report.orderRanges.tokenSpot = { asks: [startAsk.toString(), (startAsk + 19n).toString()], bids: [startBid.toString(), (startBid + 19n).toString()], partialMatches: 5 };
}

async function seedNftSpot(contracts: any, assets: any, sellers: any[], bidders: any[], owners: any[], report: SeedReport) {
  const nft = await assets.nft.getAddress();
  const quote = await assets.tokenB.getAddress();
  const startAsk = await contracts.nftSpotOrderBook.nextOrderId();
  const askTokenIds: bigint[] = [];
  for (let i = 0; i < 20; i++) {
    const seller = sellers[i % sellers.length];
    const owner = owners[i % owners.length];
    const tokenId = await mintAndDepositNft(assets.nft, seller, owner);
    askTokenIds.push(tokenId);
    await (await seller.connect(owner).placeOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), ETH, nft, tokenId, quote, 1, ethers.parseEther((8 + i).toString()), 0)).wait();
  }
  const startBid = await contracts.nftSpotOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const bidder = bidders[i % bidders.length];
    const owner = owners[(i + 2) % owners.length];
    const tokenId = askTokenIds[i];
    await depositToken(assets.tokenB, bidder, owner, ethers.parseEther("100"));
    await depositEth(bidder, owner, ethers.parseEther("0.25"));
    await (await bidder.connect(owner).placeOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), ETH, nft, tokenId, quote, 0, ethers.parseEther((7 + i).toString()), 0)).wait();
  }
  for (let i = 0; i < 4; i++) {
    const buyer = bidders[i % bidders.length];
    const owner = owners[(i + 2) % owners.length];
    await (await buyer.connect(owner).acceptOrderNFTSpot(await contracts.nftSpotOrderBook.getAddress(), startAsk + BigInt(i), ETH)).wait();
  }
  report.orderRanges.nftSpot = { asks: [startAsk.toString(), (startAsk + 19n).toString()], bids: [startBid.toString(), (startBid + 19n).toString()], filledAsks: 4, nft };
}

async function seedOptions(contracts: any, assets: any, accounts: any[], owners: any[], report: SeedReport) {
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
    await (await writer.connect(owner).placeOrderOption(await contracts.optionsOrderBook.getAddress(), OptionType.Call, asset, ETH, strike, expiry, await orderExpiryBefore(expiry), ETH, OptionIntent.WriteOption, size, premium + BigInt(i) * 10n ** 15n)).wait();
  }
  for (let i = 0; i < 5; i++) {
    const holder = accounts[(i + 4) % accounts.length];
    const owner = owners[(i + 4) % owners.length];
    await depositEth(holder, owner, premiumFor(size, premium + BigInt(i) * 10n ** 15n) + ethers.parseEther("0.5"));
    await (await holder.connect(owner).acceptOrderOption(await contracts.optionsOrderBook.getAddress(), start + BigInt(i), size / 2n, ETH)).wait();
  }
  const marketKey = await contracts.optionContract.computeMarketKey(OptionType.Call, asset, ETH, await contracts.optionContract.normalizeStrike(strike), expiry);
  report.markets.regularCallOption = { type: "regularOption", marketKey, asset, strike: strike.toString(), expiry: expiry.toString() };
  report.orderRanges.options = { writerOrders: [start.toString(), (start + 19n).toString()], partialMatches: 5 };
}

async function seedMarginBooks(contracts: any, marketKey: string, expiry: bigint, accounts: any[], owners: any[], orderbook: any, placeName: string, acceptName: string, reportKey: string, report: SeedReport) {
  const size = ethers.parseEther("3");
  const price = ethers.parseEther("0.1");
  const start = await orderbook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const writer = accounts[i % accounts.length];
    const owner = owners[i % owners.length];
    await depositEth(writer, owner, ethers.parseEther("20"));
    await (await writer.connect(owner)[placeName](await orderbook.getAddress(), marketKey, MarginIntent.WriteOption, size, price + BigInt(i) * 10n ** 15n, await orderExpiryBefore(expiry), ETH)).wait();
  }
  for (let i = 0; i < 5; i++) {
    const holder = accounts[(i + 6) % accounts.length];
    const owner = owners[(i + 6) % owners.length];
    await depositEth(holder, owner, ethers.parseEther("5"));
    await (await holder.connect(owner)[acceptName](await orderbook.getAddress(), start + BigInt(i), size / 2n, ETH)).wait();
  }
  report.orderRanges[reportKey] = { writerOrders: [start.toString(), (start + 19n).toString()], partialMatches: 5 };
}

async function seedFutures(contracts: any, marketKey: string, accounts: any[], owners: any[], report: SeedReport) {
  const startShort = await contracts.futuresOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const maker = accounts[i % accounts.length];
    const owner = owners[i % owners.length];
    await depositEth(maker, owner, futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"));
    await (await maker.connect(owner).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 1, FUTURES_PRICE + BigInt(i) * 10n ** 7n, FUTURES_SIZE, 0, ETH)).wait();
  }
  const startLong = await contracts.futuresOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const maker = accounts[(i + 5) % accounts.length];
    const owner = owners[(i + 5) % owners.length];
    await depositEth(maker, owner, futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"));
    await (await maker.connect(owner).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, FUTURES_PRICE - BigInt(i) * 10n ** 7n, FUTURES_SIZE, 0, ETH)).wait();
  }
  for (let i = 0; i < 5; i++) {
    const taker = accounts[(i + 10) % accounts.length];
    const owner = owners[(i + 10) % owners.length];
    await depositEth(taker, owner, futuresMargin(FUTURES_SIZE) + ethers.parseEther("1"));
    await (await taker.connect(owner).placeOrderFutures(await contracts.futuresOrderBook.getAddress(), marketKey, 0, FUTURES_PRICE + BigInt(i) * 10n ** 7n, FUTURES_SIZE / 2n, 0, ETH)).wait();
  }
  report.orderRanges.futures = { shortOrders: [startShort.toString(), (startShort + 19n).toString()], longOrders: [startLong.toString(), (startLong + 19n).toString()], partialMatches: 5 };
}

async function seedLending(contracts: any, normalAccounts: any[], lendingAccounts: any[], normalOwners: any[], lendingOwners: any[], report: SeedReport) {
  const expiry = await nextMonthlyExpiry(4, 75n);
  const principal = ethers.parseEther("1");
  const startLend = await contracts.lendingOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const lender = normalAccounts[i % normalAccounts.length];
    const owner = normalOwners[i % normalOwners.length];
    await depositEth(lender, owner, principal + ethers.parseEther("0.5"));
    await (await lender.connect(owner).placeLendOrder(await contracts.lendingOrderBook.getAddress(), ETH, expiry, LENDING_RISK_LEVEL, LENDING_RATE_BPS + i * 10, principal, await orderExpiryBefore(expiry))).wait();
  }
  const startBorrow = await contracts.lendingOrderBook.nextOrderId();
  for (let i = 0; i < 20; i++) {
    const borrower = lendingAccounts[i % lendingAccounts.length];
    const owner = lendingOwners[i % lendingOwners.length];
    await depositEth(borrower, owner, principal * 3n);
    await (await borrower.connect(owner).placeBorrowOrder(await contracts.lendingOrderBook.getAddress(), ETH, expiry, LENDING_RISK_LEVEL, principal, LENDING_RATE_BPS + i * 10, await orderExpiryBefore(expiry))).wait();
  }
  report.markets.lendingDepth = { type: "lending", borrowToken: ETH, expiry: expiry.toString(), riskLevel: LENDING_RISK_LEVEL };
  report.orderRanges.lending = { lendOrders: [startLend.toString(), (startLend + 19n).toString()], borrowOrders: [startBorrow.toString(), (startBorrow + 19n).toString()] };
}

async function main() {
  const deployment = readDeployment();
  const { addresses, contracts } = await getContracts(deployment);
  const signers = await ethers.getSigners();
  const [deployer, alice, bob, carol, dave, treasurer, attacker, lp1, lp2, user9, user10, user11] = signers;
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

  const owners = [alice, bob, carol, dave, lp1, lp2, user9, user10, user11].filter(Boolean);
  for (let i = 0; i < signers.length; i++) report.signers[`signer${i}`] = await signers[i].getAddress();

  console.log("Deploying frontend mock assets...");
  const assets = await deployAssets();
  report.assets = {
    tokenA: await assets.tokenA.getAddress(),
    tokenB: await assets.tokenB.getAddress(),
    tokenC: await assets.tokenC.getAddress(),
    nft: await assets.nft.getAddress(),
  };
  await mintAssets(assets, await Promise.all(owners.map((s) => s.getAddress())));

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

  console.log("Registering markets and oracles...");
  const futures1 = await createFuturesMarket(contracts, governance, `FRONT-FUT-1-${Date.now()}`, report);
  const futures2 = await createFuturesMarket(contracts, governance, `FRONT-FUT-2-${Date.now()}`, report);
  const margin = await createMarginMarket(contracts, governance, `FRONT-MARGIN-${Date.now()}`, report);
  const binary = await createBinaryMarket(contracts, governance, `FRONT-BINARY-${Date.now()}`, report);

  console.log("Creating passive pool and deposits...");
  const passivePool = await createPassivePool(contracts, governance, futures2.marketKey, report);
  if (passivePool) {
    await tx("public LP deposit to passive pool", () => passivePool.connect(lp1).deposit({ value: ethers.parseEther("25") }), report, false);
    await tx("publish passive snapshot", () => contracts.passiveFuturesSnapshotPublisher.connect(treasurer).publishPassiveSnapshot(futures2.marketKey, FUTURES_PRICE - 10n ** 8n, FUTURES_SIZE * 10n, FUTURES_PRICE + 10n ** 8n, FUTURES_SIZE * 10n, 100n, "frontend seed passive quotes"), report, false);
  }

  console.log("Seeding spot books...");
  await seedTokenSpot(contracts, assets, normalAccounts.slice(0, 8), normalAccounts.slice(8, 16), normalOwners, report);
  await seedNftSpot(contracts, assets, normalAccounts.slice(0, 8), normalAccounts.slice(8, 16), normalOwners, report);

  console.log("Seeding option books...");
  await seedOptions(contracts, assets, normalAccounts, normalOwners, report);
  await seedMarginBooks(contracts, margin.marketKey, margin.expiry, normalAccounts, normalOwners, contracts.marginOptionsOrderBook, "placeOrderMarginOption", "acceptOrderMarginOption", "marginOptions", report);
  await seedMarginBooks(contracts, binary.marketKey, binary.expiry, normalAccounts, normalOwners, contracts.binaryMarginOptionsOrderBook, "placeOrderBinaryMarginOption", "acceptOrderBinaryMarginOption", "binaryMarginOptions", report);

  console.log("Seeding futures and lending books...");
  await seedFutures(contracts, futures1.marketKey, normalAccounts, normalOwners, report);
  await seedLending(contracts, normalAccounts, lendingAccounts, normalOwners, lendingOwners, report);

  console.log("Configuring treasury account for frontend treasurer...");
  const treasuryAccount = await setupTreasury(contracts, addresses, governance, treasurer, report.assets.tokenB, report);
  if (treasuryAccount) {
    await tx("fund treasury account with ETH", () => contracts.treasuryTradeModule.connect(treasurer).depositETHToAccount(await treasuryAccount.getAddress(), ethers.parseEther("50")), report, false);
    await tx("seed treasury spot order", () => contracts.treasuryTradeModule.connect(treasurer).placeSpotOrder(await treasuryAccount.getAddress(), addresses.tokenSpotOrderBook, ETH, report.assets.tokenB, report.assets.tokenA, 0, ethers.parseEther("0.95"), ethers.parseEther("25"), 0), report, false);
  }

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nFrontend exchange seed complete. Report written to ${REPORT_PATH}`);
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
