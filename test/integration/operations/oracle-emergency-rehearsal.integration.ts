import { expect } from "chai";
import { network } from "hardhat";

import {
  loadActors,
  loadIntegratedDeployment,
} from "../helpers/integration-deployment.js";
import { impersonateTimelock } from "../helpers/governance.js";

const { ethers } = await network.create();

const OracleStatus = {
  OK: 0,
  DEGRADED: 1,
  FROZEN: 2,
  PENDING: 3,
  STALE: 4,
} as const;

const OracleContext = {
  FUTURE_SETTLEMENT: 2,
} as const;

const PRICE_DECIMALS = 8n;
const INITIAL_PRICE = 2_000n * 10n ** PRICE_DECIMALS;
const REPLACEMENT_PRICE = 2_050n * 10n ** PRICE_DECIMALS;

async function deployMockOracle(pair: string, initialPrice: bigint) {
  const oracle = await ethers.deployContract("MockPriceOracle", [pair, 8, initialPrice]);
  await oracle.waitForDeployment();
  return oracle;
}

async function registerFuturesOracle(priceManager: any, governance: any, oracle: any) {
  const oracleAddress = await oracle.getAddress();
  await (await priceManager.connect(governance).approveOracle(oracleAddress)).wait();
  await (
    await priceManager.connect(governance).approveOracleForContext(oracleAddress, OracleContext.FUTURE_SETTLEMENT)
  ).wait();
  await (await priceManager.syncOracleData(oracleAddress)).wait();
  return oracleAddress;
}

describe("Emergency governance and oracle replacement rehearsal", function () {
  it("freezes an unsafe futures oracle, confirms it is unusable, then registers a replacement oracle", async function () {
    const { addresses, contracts } = await loadIntegratedDeployment(ethers);
    await loadActors(ethers);
    const governance = await impersonateTimelock(ethers, addresses.sethxTimelock);

    const primary = await deployMockOracle("EMERGENCY-FUT/USD", INITIAL_PRICE);
    const primaryAddress = await registerFuturesOracle(contracts.priceManager, governance, primary);
    expect(await contracts.priceManager.isOracleUsableForFutures(primaryAddress), "primary starts usable").to.equal(true);

    await (await contracts.priceManager.connect(governance).setOracleStatus(primaryAddress, OracleStatus.FROZEN)).wait();
    expect(await contracts.priceManager.isOracleUsableForFutures(primaryAddress), "frozen oracle unusable").to.equal(false);

    await (await contracts.priceManager.connect(governance).setOracleStatus(primaryAddress, OracleStatus.OK)).wait();
    await (await contracts.priceManager.syncOracleData(primaryAddress)).wait();
    expect(await contracts.priceManager.isOracleUsableForFutures(primaryAddress), "unfrozen oracle usable again").to.equal(true);

    const replacement = await deployMockOracle("EMERGENCY-FUT-REPLACEMENT/USD", REPLACEMENT_PRICE);
    const replacementAddress = await registerFuturesOracle(contracts.priceManager, governance, replacement);
    expect(await contracts.priceManager.isOracleUsableForFutures(replacementAddress), "replacement oracle usable").to.equal(true);

    const [price, decimals] = await contracts.priceManager.getOraclePrice(
      replacementAddress,
      OracleContext.FUTURE_SETTLEMENT,
    );
    expect(price, "replacement oracle price").to.equal(REPLACEMENT_PRICE);
    expect(decimals, "replacement oracle decimals").to.equal(8);
  });
});
