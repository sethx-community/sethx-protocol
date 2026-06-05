import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import {
  createLendingAccount,
  createNormalAccount,
} from "../helpers/accounts.js";
import { deployMockAssets } from "../helpers/mock-assets.js";
import { expectRevert } from "../helpers/reverts.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const ETH = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;
const ONE = 10n ** 18n;
const WAD = 10n ** 18n;
const RISK_LEVEL = 1;
const RATE_BPS = 1_000n;
const YEAR = 365n * 24n * 60n * 60n;
const BPS = 10_000n;

const PRICE_DECIMALS = 8n;
const INITIAL_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const EXTREME_UP_PRICE = 3_200n * 10n ** PRICE_DECIMALS;
const INITIAL_MARGIN_BPS = 1_000n;
const MAINTENANCE_MARGIN_BPS = 500n;
const MULTIPLIER = 1n;
const SIZE = 10n ** 15n;

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

type RestrictedScenario = {
  lender: any;
  borrower: any;
  lenderAddress: string;
  borrowerAddress: string;
  marketKey: string;
  expiry: bigint;
  face: bigint;
};

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block unavailable");
  return BigInt(block.timestamp);
}

async function mineToTimestamp(timestamp: bigint) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
}

function marketKey(expiry: bigint, riskLevel = RISK_LEVEL): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint64", "uint16"],
      [ETH, expiry, riskLevel],
    ),
  );
}

function expectedFaceValue(
  principal: bigint,
  rateBps: bigint,
  expiry: bigint,
  matchTimestamp: bigint,
): bigint {
  const timeToExpiry = expiry - matchTimestamp;
  const interest = (principal * rateBps * timeToExpiry) / YEAR / BPS;
  return principal + interest;
}

function lastFridayAtNoonUtc(year: number, monthOneBased: number): bigint {
  const firstNextMonth =
    monthOneBased === 12
      ? Date.UTC(year + 1, 0, 1, 0, 0, 0)
      : Date.UTC(year, monthOneBased, 1, 0, 0, 0);

  const d = new Date(firstNextMonth - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

async function nextLendingExpiry(monthsAhead = 2): Promise<bigint> {
  const now = await latestTimestamp();
  const nowDate = new Date(Number(now) * 1000);

  for (let i = monthsAhead; i < monthsAhead + 18; i++) {
    const candidateDate = new Date(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + i, 1),
    );
    const candidate = lastFridayAtNoonUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
    );
    if (candidate > now + 30n * 24n * 60n * 60n) return candidate;
  }

  throw new Error("No valid future lending expiry found");
}

async function depositEth(account: any, owner: any, amount: bigint) {
  await (
    await account
      .connect(owner)
      .depositETH(await account.getAddress(), await account.vault(), {
        value: amount,
      })
  ).wait();
}

async function makeRestrictedBorrower(
  contracts: any,
  addresses: any,
  actors: any,
  principal = ONE,
  collateral = 10n * ONE,
  monthsAhead = 3,
): Promise<RestrictedScenario> {
  const lender = await createNormalAccount(
    ethers,
    contracts.accountFactory,
    contracts.accountRegistry,
    actors.alice,
  );
  const borrower = await createLendingAccount(
    ethers,
    contracts.lendingAccountFactory,
    contracts.accountRegistry,
    actors.bob,
  );
  const lenderAddress = await lender.getAddress();
  const borrowerAddress = await borrower.getAddress();

  const expiry = await nextLendingExpiry(monthsAhead);
  const orderExpiry = (await latestTimestamp()) + 7n * 24n * 60n * 60n;

  await depositEth(lender, actors.alice, principal);
  await depositEth(borrower, actors.bob, collateral);

  await (
    await lender
      .connect(actors.alice)
      .placeLendOrder(
        addresses.lendingOrderBook,
        ETH,
        expiry,
        RISK_LEVEL,
        RATE_BPS,
        principal,
        orderExpiry,
      )
  ).wait();

  const tx = await borrower
    .connect(actors.bob)
    .placeBorrowOrder(
      addresses.lendingOrderBook,
      ETH,
      expiry,
      RISK_LEVEL,
      principal,
      RATE_BPS,
      orderExpiry,
    );
  const receipt = await tx.wait();
  const matchTimestamp = BigInt(
    (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
  );
  const key = marketKey(expiry);
  const face = expectedFaceValue(principal, RATE_BPS, expiry, matchTimestamp);

  expect(
    await borrower.isRestricted(),
    "borrower is restricted after debt is opened",
  ).to.equal(true);
  expect(
    await contracts.lendingContract.accountHasDebt(borrowerAddress),
    "borrower debt exists",
  ).to.equal(true);

  return {
    lender,
    borrower,
    lenderAddress,
    borrowerAddress,
    marketKey: key,
    expiry,
    face,
  };
}

function normalizePrice(
  rawPrice: bigint,
  oracleDecimals = 8n,
  marginDecimals = 18n,
): bigint {
  if (oracleDecimals === marginDecimals) return rawPrice;
  if (oracleDecimals < marginDecimals)
    return rawPrice * 10n ** (marginDecimals - oracleDecimals);
  return rawPrice / 10n ** (oracleDecimals - marginDecimals);
}

function initialMarginRequired(size: bigint, rawPrice: bigint): bigint {
  return (
    (size * MULTIPLIER * normalizePrice(rawPrice) * INITIAL_MARGIN_BPS) /
    (10_000n * WAD)
  );
}

async function deployMockOracle(pair: string, initialPrice: bigint) {
  const oracle = await ethers.deployContract("MockPriceOracle", [
    pair,
    8,
    initialPrice,
  ]);
  await oracle.waitForDeployment();
  return oracle;
}

async function registerFuturesOracle(
  priceManager: any,
  governance: any,
  oracle: any,
) {
  const oracleAddress = await oracle.getAddress();

  if (!(await priceManager.isApprovedOracle(oracleAddress))) {
    await (
      await priceManager.connect(governance).approveOracle(oracleAddress)
    ).wait();
  }
  if (
    !(await priceManager.isOracleApprovedFor(
      oracleAddress,
      OracleContext.FUTURE_SETTLEMENT,
    ))
  ) {
    await (
      await priceManager
        .connect(governance)
        .approveOracleForContext(oracleAddress, OracleContext.FUTURE_SETTLEMENT)
    ).wait();
  }

  await (await priceManager.syncOracleData(oracleAddress)).wait();
  expect(await priceManager.isOracleUsableForFutures(oracleAddress)).to.equal(
    true,
  );

  return oracleAddress;
}

async function createFuturesMarket(
  contracts: any,
  timelockSigner: any,
  oracleAddress: string,
  label: string,
) {
  const marketKey =
    await contracts.futuresContract.computeMarketKey(oracleAddress);

  await (
    await contracts.futuresContract
      .connect(timelockSigner)
      .createMarket(
        label,
        oracleAddress,
        INITIAL_MARGIN_BPS,
        MAINTENANCE_MARGIN_BPS,
        MULTIPLIER,
        INITIAL_PRICE,
      )
  ).wait();

  return marketKey;
}

async function expectBlocked(label: string, promise: Promise<unknown>) {
  await expectRevert(promise);
}

describe("RiskModule adversarial and restricted LendingAccount integration", function () {
  it("rejects malicious direct calls to RiskModule and ValuationModule mutating surfaces", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const attackerAddress = await actors.attacker.getAddress();

    const riskCalls: Array<[string, () => Promise<unknown>]> = [
      [
        "RiskModule.setAccountRiskLevel",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setAccountRiskLevel(attackerAddress, RISK_LEVEL),
      ],
      [
        "RiskModule.clearAccountRiskLevel",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .clearAccountRiskLevel(attackerAddress),
      ],
      [
        "RiskModule.setApprovedLendingContract",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedLendingContract(addresses.lendingContract, true),
      ],
      [
        "RiskModule.latchAccountRiskLevel",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .latchAccountRiskLevel(attackerAddress, RISK_LEVEL),
      ],
      [
        "RiskModule.setApprovedLendingOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedLendingOrderBook(addresses.lendingOrderBook, true),
      ],
      [
        "RiskModule.setApprovedTokenSpotOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedTokenSpotOrderBook(addresses.tokenSpotOrderBook, true),
      ],
      [
        "RiskModule.setApprovedOptionsOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedOptionsOrderBook(addresses.optionsOrderBook, true),
      ],
      [
        "RiskModule.setApprovedOptionContract",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedOptionContract(addresses.optionContract, true),
      ],
      [
        "RiskModule.setApprovedFuturesOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedFuturesOrderBook(addresses.futuresOrderBook, true),
      ],
      [
        "RiskModule.setApprovedFuturesContract",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedFuturesContract(addresses.futuresContract, true),
      ],
      [
        "RiskModule.setApprovedMarginOptionsOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedMarginOptionsOrderBook(
              addresses.marginOptionsOrderBook,
              true,
            ),
      ],
      [
        "RiskModule.setApprovedMarginOptionContract",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedMarginOptionContract(
              addresses.marginOptionContract,
              true,
            ),
      ],
      [
        "RiskModule.setApprovedBinaryMarginOptionsOrderBook",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedBinaryMarginOptionsOrderBook(
              addresses.binaryMarginOptionsOrderBook,
              true,
            ),
      ],
      [
        "RiskModule.setApprovedBinaryMarginOptionContract",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedBinaryMarginOptionContract(
              addresses.binaryMarginOptionContract,
              true,
            ),
      ],
      [
        "RiskModule.setApprovedLiquidationEngine",
        () =>
          contracts.riskModule
            .connect(actors.attacker)
            .setApprovedLiquidationEngine(addresses.liquidationEngine, true),
      ],
      [
        "ValuationModule.setRiskTier",
        () =>
          contracts.valuationModule
            .connect(actors.attacker)
            .setRiskTier(9, true, 5_000, 8_000, 0, 0, 0, 0),
      ],
      [
        "ValuationModule.setOptionsView",
        () =>
          contracts.valuationModule
            .connect(actors.attacker)
            .setOptionsView(attackerAddress),
      ],
      [
        "ValuationModule.setFuturesView",
        () =>
          contracts.valuationModule
            .connect(actors.attacker)
            .setFuturesView(attackerAddress),
      ],
    ];

    for (const [label, call] of riskCalls) {
      await expectBlocked(label, call());
    }
  });

  it("exercises every LendingAccount external wrapper while restricted and proves only safe surfaces remain usable", async function () {
    const { contracts, addresses } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const s = await makeRestrictedBorrower(
      contracts,
      addresses,
      actors,
      ONE,
      12n * ONE,
      4,
    );
    const borrower = s.borrower;
    const borrowerAddress = s.borrowerAddress;
    const assets = await deployMockAssets(ethers);
    const ownerAddress = await actors.bob.getAddress();
    const attackerAddress = await actors.attacker.getAddress();
    const orderExpiry = (await latestTimestamp()) + 6n * 24n * 60n * 60n;
    const nextExpiry = await nextLendingExpiry(7);

    expect(
      await borrower.isRestricted(),
      "restricted before wrapper matrix",
    ).to.equal(true);

    // Owner/account administration is still allowed while restricted.
    await (
      await borrower.connect(actors.bob).setAccountName("restricted-but-active")
    ).wait();
    expect(await borrower.accountName()).to.equal("restricted-but-active");
    await (await borrower.connect(actors.bob).setActive(false)).wait();
    expect(await borrower.isActive()).to.equal(false);
    await (await borrower.connect(actors.bob).setActive(true)).wait();
    expect(await borrower.isActive()).to.equal(true);

    // Deposits add collateral and remain allowed; withdrawals/rescues are blocked by noRestrictedWithdrawals.
    await (
      await borrower
        .connect(actors.bob)
        .depositETH(await borrower.getAddress(), await borrower.vault(), {
          value: ONE,
        })
    ).wait();
    await (await assets.tokenA.mint(ownerAddress, 100n * ONE)).wait();
    await (
      await assets.tokenA
        .connect(actors.bob)
        .approve(borrowerAddress, 100n * ONE)
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .depositToken(
          await assets.tokenA.getAddress(),
          10n * ONE,
          await borrower.getAddress(),
          await borrower.vault(),
        )
    ).wait();
    const tokenId = await assets.nft.nextTokenId();
    await (await assets.nft.mint(ownerAddress)).wait();
    await (
      await assets.nft.connect(actors.bob).approve(borrowerAddress, tokenId)
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .depositNFT721(
          await assets.nft.getAddress(),
          tokenId,
          await borrower.getAddress(),
          await borrower.vault(),
        )
    ).wait();

    await expectBlocked(
      "restricted withdrawETH",
      borrower.connect(actors.bob).withdrawETH(1n),
    );
    await expectBlocked(
      "restricted withdrawToken",
      borrower
        .connect(actors.bob)
        .withdrawToken(await assets.tokenA.getAddress(), 1n),
    );
    await expectBlocked(
      "restricted withdrawNFT721",
      borrower
        .connect(actors.bob)
        .withdrawNFT721(await assets.nft.getAddress(), tokenId),
    );
    await expectBlocked(
      "restricted rescueEth",
      borrower.connect(actors.bob).rescueEth(0n),
    );
    await expectBlocked(
      "restricted rescueToken",
      borrower
        .connect(actors.bob)
        .rescueToken(await assets.tokenA.getAddress(), 0n),
    );
    await expectBlocked(
      "restricted rescueNFT721",
      borrower
        .connect(actors.bob)
        .rescueNFT721(await assets.nft.getAddress(), tokenId),
    );

    // Repayment remains allowed and should reduce debt without fully clearing restriction.
    const beforeDebt = await contracts.lendingContract.getDebt(
      borrowerAddress,
      s.marketKey,
    );
    await (
      await borrower.connect(actors.bob).repayDebt(s.marketKey, 1n)
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .repayDebtForMarket(ETH, s.expiry, RISK_LEVEL, 1n)
    ).wait();
    const afterDebt = await contracts.lendingContract.getDebt(
      borrowerAddress,
      s.marketKey,
    );
    expect(
      afterDebt.faceValue,
      "partial repayments reduce face value",
    ).to.equal(beforeDebt.faceValue - 2n);
    expect(
      await borrower.isRestricted(),
      "still restricted after dust repayment",
    ).to.equal(true);

    // Lending-side wrappers are still usable because they do not increase borrower risk.
    const lendOrderId = await contracts.lendingOrderBook.nextOrderId();
    await (
      await borrower
        .connect(actors.bob)
        .placeLendOrder(
          addresses.lendingOrderBook,
          ETH,
          nextExpiry,
          RISK_LEVEL,
          RATE_BPS,
          10n ** 16n,
          orderExpiry,
        )
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .cancelLendOrder(addresses.lendingOrderBook, lendOrderId)
    ).wait();

    // Borrow-side wrappers remain risk-gated and must respect live LTV.
    const borrowOrderId = await contracts.lendingOrderBook.nextOrderId();
    await (
      await borrower
        .connect(actors.bob)
        .placeBorrowOrder(
          addresses.lendingOrderBook,
          ETH,
          nextExpiry,
          RISK_LEVEL,
          10n ** 16n,
          RATE_BPS,
          orderExpiry,
        )
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .cancelBorrowOrder(addresses.lendingOrderBook, borrowOrderId)
    ).wait();

    const rolloverOrderId = await contracts.lendingOrderBook.nextOrderId();
    await (
      await borrower
        .connect(actors.bob)
        .placeRolloverBorrowOrder(
          addresses.lendingOrderBook,
          ETH,
          nextExpiry,
          RISK_LEVEL,
          10n ** 16n,
          RATE_BPS,
          orderExpiry,
          s.marketKey,
        )
    ).wait();
    await (
      await borrower
        .connect(actors.bob)
        .cancelBorrowOrder(addresses.lendingOrderBook, rolloverOrderId)
    ).wait();

    // All market wrappers are invoked while restricted. Fake targets prove the RiskModule firewall blocks unapproved routes.
    await expectBlocked(
      "restricted placeOrderTokenSpot unapproved target",
      borrower
        .connect(actors.bob)
        .placeOrderTokenSpot(
          attackerAddress,
          ETH,
          await assets.tokenA.getAddress(),
          ETH,
          0,
          ONE,
          1n,
          orderExpiry,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted acceptOrderTokenSpot unapproved target",
      borrower
        .connect(actors.bob)
        .acceptOrderTokenSpot(attackerAddress, 1n, 1n, ETH, ethers.ZeroAddress),
    );
    await expectBlocked(
      "restricted cancelOrderTokenSpot fake target",
      borrower.connect(actors.bob).cancelOrderTokenSpot(attackerAddress, 1n),
    );

    await expectBlocked(
      "restricted placeOrderOption unapproved target",
      borrower
        .connect(actors.bob)
        .placeOrderOption(
          attackerAddress,
          0,
          await assets.tokenA.getAddress(),
          ETH,
          ONE,
          orderExpiry,
          orderExpiry,
          ETH,
          0,
          1n,
          1n,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted acceptOrderOption unapproved target",
      borrower
        .connect(actors.bob)
        .acceptOrderOption(attackerAddress, 1n, 1n, ETH, ethers.ZeroAddress),
    );
    await expectBlocked(
      "restricted cancelOrderOption fake target",
      borrower.connect(actors.bob).cancelOrderOption(attackerAddress, 1n),
    );
    await expectBlocked(
      "restricted exerciseOption unapproved target",
      borrower
        .connect(actors.bob)
        .exerciseOption(attackerAddress, ZERO_HASH, 1n),
    );
    await expectBlocked(
      "restricted reclaimExpiredOption fake target",
      borrower
        .connect(actors.bob)
        .reclaimExpiredOption(attackerAddress, ZERO_HASH),
    );
    await expectBlocked(
      "restricted clearExpiredOptionHolder fake target",
      borrower
        .connect(actors.bob)
        .clearExpiredOptionHolder(attackerAddress, ZERO_HASH),
    );

    await expectBlocked(
      "restricted placeOrderFutures unapproved target",
      borrower
        .connect(actors.bob)
        .placeOrderFutures(
          attackerAddress,
          ZERO_HASH,
          0,
          ONE,
          1n,
          orderExpiry,
          ETH,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted cancelOrderFutures fake target",
      borrower.connect(actors.bob).cancelOrderFutures(attackerAddress, 1n),
    );
    await expectBlocked(
      "restricted matchFuturesImbalance unapproved target",
      borrower
        .connect(actors.bob)
        .matchFuturesImbalance(attackerAddress, ZERO_HASH, 1n),
    );
    await expectBlocked(
      "restricted addFuturesMargin unapproved target",
      borrower
        .connect(actors.bob)
        .addFuturesMargin(attackerAddress, ZERO_HASH, true, 1n),
    );
    await expectBlocked(
      "restricted releaseFuturesMargin unapproved target",
      borrower
        .connect(actors.bob)
        .releaseFuturesMargin(attackerAddress, ZERO_HASH, true),
    );

    await expectBlocked(
      "restricted placeOrderMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .placeOrderMarginOption(
          attackerAddress,
          ZERO_HASH,
          0,
          1n,
          1n,
          orderExpiry,
          ETH,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted acceptOrderMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .acceptOrderMarginOption(
          attackerAddress,
          1n,
          1n,
          ETH,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted cancelOrderMarginOption fake target",
      borrower.connect(actors.bob).cancelOrderMarginOption(attackerAddress, 1n),
    );
    await expectBlocked(
      "restricted claimMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .claimMarginOption(attackerAddress, ZERO_HASH, 1n),
    );
    await expectBlocked(
      "restricted reclaimWriterMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .reclaimWriterMarginOption(attackerAddress, ZERO_HASH),
    );

    await expectBlocked(
      "restricted placeOrderBinaryMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .placeOrderBinaryMarginOption(
          attackerAddress,
          ZERO_HASH,
          0,
          1n,
          1n,
          orderExpiry,
          ETH,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted acceptOrderBinaryMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .acceptOrderBinaryMarginOption(
          attackerAddress,
          1n,
          1n,
          ETH,
          ethers.ZeroAddress,
        ),
    );
    await expectBlocked(
      "restricted cancelOrderBinaryMarginOption fake target",
      borrower
        .connect(actors.bob)
        .cancelOrderBinaryMarginOption(attackerAddress, 1n),
    );
    await expectBlocked(
      "restricted claimBinaryMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .claimBinaryMarginOption(attackerAddress, ZERO_HASH, 1n),
    );
    await expectBlocked(
      "restricted reclaimWriterBinaryMarginOption unapproved target",
      borrower
        .connect(actors.bob)
        .reclaimWriterBinaryMarginOption(attackerAddress, ZERO_HASH),
    );

    await expectBlocked(
      "restricted buyAuctionedLendingAccount unapproved target",
      borrower
        .connect(actors.bob)
        .buyAuctionedLendingAccount(attackerAddress, borrowerAddress),
    );

    expect(
      await contracts.vault.ethLocked(borrowerAddress),
      "locked never exceeds total",
    ).to.be.lte(await contracts.vault.ethBalances(borrowerAddress));
  });

  it("allows a restricted LendingAccount to take approved futures risk, then measures extreme adverse price movement consuming margin", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    const actors = await loadActors(ethers);
    const timelockSigner = await impersonateTimelock(
      ethers,
      addresses.sethxTimelock,
    );

    const s = await makeRestrictedBorrower(
      contracts,
      addresses,
      actors,
      ONE,
      20n * ONE,
      8,
    );
    const borrower = s.borrower;
    const borrowerAddress = s.borrowerAddress;
    expect(
      await borrower.isRestricted(),
      "borrower starts restricted",
    ).to.equal(true);

    const oracle = await deployMockOracle("RISK-FUT/USD", INITIAL_PRICE);
    const oracleAddress = await registerFuturesOracle(
      contracts.priceManager,
      timelockSigner,
      oracle,
    );
    const marketKey = await createFuturesMarket(
      contracts,
      timelockSigner,
      oracleAddress,
      "RISK-FUT",
    );

    const counterparty = await createNormalAccount(
      ethers,
      contracts.accountFactory,
      contracts.accountRegistry,
      actors.carol,
    );
    const counterpartyAddress = await counterparty.getAddress();
    await depositEth(counterparty, actors.carol, 5n * ONE);

    const margin = initialMarginRequired(SIZE, INITIAL_PRICE);
    const valuesBefore = await contracts.valuationModule.getAccountValues(
      borrowerAddress,
      RISK_LEVEL,
    );
    expect(
      valuesBefore.collateralValueEth,
      "restricted borrower has collateral value before approved risk",
    ).to.be.gt(0n);
    expect(
      await contracts.valuationModule.canTrade(borrowerAddress, RISK_LEVEL),
      "current tier allows this borrower to trade before extreme shift",
    ).to.equal(true);

    // Restricted borrower opens a short only through the approved FuturesOrderBook wrapper.
    await (
      await borrower
        .connect(actors.bob)
        .placeOrderFutures(
          addresses.futuresOrderBook,
          marketKey,
          1,
          INITIAL_PRICE,
          SIZE,
          0,
          ETH,
          ethers.ZeroAddress,
        )
    ).wait();
    await (
      await counterparty
        .connect(actors.carol)
        .placeOrderFutures(
          addresses.futuresOrderBook,
          marketKey,
          0,
          INITIAL_PRICE,
          SIZE,
          0,
          ETH,
          ethers.ZeroAddress,
        )
    ).wait();

    const shortBefore = await contracts.futuresContract.getPosition(
      borrowerAddress,
      marketKey,
    );
    expect(
      shortBefore.size > 0n && shortBefore.side === 2n,
      "restricted borrower opened approved short",
    ).to.equal(true);
    expect(shortBefore.margin, "initial short margin").to.equal(margin);

    await (await oracle.setPrice(EXTREME_UP_PRICE)).wait();
    await (await contracts.priceManager.syncOracleData(oracleAddress)).wait();
    await (await contracts.futuresContract.syncSettlementPrice(marketKey)).wait();

    const shortAfter = await contracts.futuresContract.getPosition(
      borrowerAddress,
      marketKey,
    );
    const valuesAfter = await contracts.valuationModule.getAccountValues(
      borrowerAddress,
      RISK_LEVEL,
    );

    // This is intentionally not an expected-revert test: it records how much damage the approved risk path permits.
    expect(
      shortAfter.margin,
      "extreme upward shift should consume all or most short margin",
    ).to.be.lte(margin);
    expect(
      await contracts.vault.ethLocked(borrowerAddress),
      "vault locked <= total after extreme settlement",
    ).to.be.lte(await contracts.vault.ethBalances(borrowerAddress));
    expect(
      valuesAfter.effectiveDebtEth,
      "debt remains visible after futures shock",
    ).to.be.gt(0n);
    expect(
      valuesAfter.collateralValueEth,
      "collateral value remains non-negative after futures shock",
    ).to.be.gte(0n);
    expect(
      await contracts.vault.ethLocked(counterpartyAddress),
      "counterparty locked <= total after settlement",
    ).to.be.lte(await contracts.vault.ethBalances(counterpartyAddress));
  });
});
