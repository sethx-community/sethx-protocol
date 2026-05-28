import { expect } from "chai";

import {
  readLocalDeployment,
  requireLocalAddress,
} from "../helpers/deployment-reader.js";

const REQUIRED_STAGES = [
  "00",
  "10",
  "20",
  "21",
  "30",
  "40",
  "41",
  "42",
  "50",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "59",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "67",
  "68",
  "69",
  "70",
  "71",
  "72",
  "73",
  "74",
  "75",
  "76",
  "77",
  "78",
  "79",
  "80",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
  "87",
  "88",
] as const;

const REQUIRED_ADDRESS_KEYS = [
  "sethxToken",
  "founderTokenTimelock",
  "treasuryAuthority",
  "protocolTreasury",
  "sethxTimelock",
  "sethxGovernor",
  "accountRegistry",
  "sethxVault",
  "priceManager",
  "feeManager",
  "tokenSpotOrderBook",
  "nftSpotOrderBook",
  "optionContract",
  "optionsOrderBook",
  "binaryMarginOptionContract",
  "binaryMarginOptionsOrderBook",
  "marginOptionContract",
  "marginOptionsOrderBook",
  "futuresContract",
  "futuresOrderBook",
  "settlementManager",
  "lendingContract",
  "lendingOrderBook",
  "optionsValuationAdapter",
  "futuresValuationAdapter",
  "valuationModule",
  "riskModule",
  "liquidationEngine",
  "accountFactory",
  "lendingAccountFactory",
  "treasuryPaymentsModule",
  "treasuryVaultModule",
  "treasuryTradeModule",
  "sethxFeeConversionOracle",
  "passiveFuturesSnapshotPublisher",
  "passiveFuturesPoolFactory",
] as const;

function expectAddress(address: string) {
  expect(address).to.match(/^0x[a-fA-F0-9]{40}$/);
}

describe("Final deployment state", function () {
  it("records every required production deployment stage", function () {
    const deployment = readLocalDeployment();

    for (const stage of REQUIRED_STAGES) {
      expect(
        deployment.stages?.[stage],
        `missing deployment stage ${stage}`,
      ).to.not.equal(undefined);
    }
  });

  it("records all required final deployment addresses", function () {
    const deployment = readLocalDeployment();

    for (const key of REQUIRED_ADDRESS_KEYS) {
      const address = requireLocalAddress(deployment, key);
      expectAddress(address);
    }
  });

  it("records token distribution and governance output sections", function () {
    const deployment = readLocalDeployment();

    expect(deployment.tokenDistribution).to.not.equal(undefined);
    expect(BigInt(deployment.tokenDistribution.totalSupply)).to.be.greaterThan(0n);
    expect(BigInt(deployment.tokenDistribution.founderAmount)).to.be.greaterThan(0n);
    expect(BigInt(deployment.tokenDistribution.treasuryAmount)).to.be.greaterThan(0n);

    expect(deployment.governance).to.not.equal(undefined);
    expect(BigInt(deployment.governance!.timelockDelaySeconds)).to.be.greaterThan(0n);
    expect(BigInt(deployment.governance!.votingPeriodBlocks)).to.be.greaterThan(0n);
    expect(BigInt(deployment.governance!.quorumBps)).to.be.greaterThan(0n);
  });
});
