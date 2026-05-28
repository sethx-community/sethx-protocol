import { expect } from "chai";
import { network } from "hardhat";

import {
  readLocalDeployment,
  type LocalDeploymentOutput,
} from "../../helpers/deployment-reader.js";

import { loadActors } from "../helpers/integration-deployment.js";
import {
  maliciousCallSweep,
  mutatingFragments,
  type SweepAllowance,
  type SweepTarget,
} from "../helpers/abi-sweep.js";

const { ethers } = await network.create();

type AddressKey = keyof LocalDeploymentOutput["addresses"];

const DEPLOYED_PROTOCOL_TARGETS: Array<{
  key: AddressKey;
  contractName: string;
}> = [
  { key: "sethxToken", contractName: "SethxToken" },
  { key: "founderTokenTimelock", contractName: "FounderTokenTimelock" },
  { key: "treasuryAuthority", contractName: "TreasuryAuthority" },
  { key: "protocolTreasury", contractName: "ProtocolTreasury" },
  { key: "sethxTimelock", contractName: "SethxTimelock" },
  { key: "sethxGovernor", contractName: "SethxGovernor" },
  { key: "accountRegistry", contractName: "AccountRegistry" },
  { key: "sethxVault", contractName: "SethxVault" },
  { key: "priceManager", contractName: "PriceManager" },
  { key: "feeManager", contractName: "FeeManager" },
  { key: "tokenSpotOrderBook", contractName: "TokenSpotOrderBook" },
  { key: "nftSpotOrderBook", contractName: "NFTSpotOrderBook" },
  { key: "optionContract", contractName: "OptionContract" },
  { key: "optionsOrderBook", contractName: "OptionsOrderBook" },
  {
    key: "binaryMarginOptionContract",
    contractName: "BinaryMarginOptionContract",
  },
  {
    key: "binaryMarginOptionsOrderBook",
    contractName: "BinaryMarginOptionsOrderBook",
  },
  { key: "marginOptionContract", contractName: "MarginOptionContract" },
  { key: "marginOptionsOrderBook", contractName: "MarginOptionsOrderBook" },
  { key: "futuresContract", contractName: "FuturesContract" },
  { key: "futuresOrderBook", contractName: "FuturesOrderBook" },
  { key: "settlementManager", contractName: "SettlementManager" },
  { key: "lendingContract", contractName: "LendingContract" },
  { key: "lendingOrderBook", contractName: "LendingOrderBook" },
  { key: "optionsValuationAdapter", contractName: "OptionsValuationAdapter" },
  { key: "futuresValuationAdapter", contractName: "FuturesValuationAdapter" },
  { key: "valuationModule", contractName: "ValuationModule" },
  { key: "riskModule", contractName: "RiskModule" },
  { key: "liquidationEngine", contractName: "LiquidationEngine" },
  { key: "accountFactory", contractName: "AccountFactory" },
  { key: "lendingAccountFactory", contractName: "LendingAccountFactory" },
  { key: "treasuryPaymentsModule", contractName: "TreasuryPaymentsModule" },
  { key: "treasuryVaultModule", contractName: "TreasuryVaultModule" },
  { key: "treasuryTradeModule", contractName: "TreasuryTradeModule" },
  { key: "sethxFeeConversionOracle", contractName: "SethxFeeConversionOracle" },
  {
    key: "passiveFuturesSnapshotPublisher",
    contractName: "PassiveFuturesSnapshotPublisher",
  },
  {
    key: "passiveFuturesPoolFactory",
    contractName: "PassiveFuturesPoolFactory",
  },
];

const INTENTIONALLY_PUBLIC_OR_SELF_SERVICE: SweepAllowance[] = [
  {
    functionName: "renounceRole",
    reason:
      "OpenZeppelin AccessControl self-service function. It cannot grant privileges and uses msg.sender confirmation.",
  },
  {
    contractName: "SethxToken",
    functionName: "approve",
    reason: "ERC20 holder self-service allowance operation.",
  },
  {
    contractName: "SethxToken",
    functionName: "transfer",
    reason: "ERC20 holder self-service transfer operation.",
  },
  {
    contractName: "SethxToken",
    functionName: "transferFrom",
    reason: "ERC20 holder self-service allowance transfer operation.",
  },
  {
    contractName: "SethxToken",
    functionName: "permit",
    reason: "ERC20Permit public signature-based approval path.",
  },
  {
    contractName: "SethxToken",
    functionName: "delegate",
    reason: "ERC20Votes holder self-service vote delegation operation.",
  },
  {
    contractName: "SethxToken",
    functionName: "delegateBySig",
    reason: "ERC20Votes public signature-based delegation path.",
  },
  {
    contractName: "FounderTokenTimelock",
    functionName: "release",
    reason:
      "OpenZeppelin vesting/timelock release is intentionally public, but pays only the configured beneficiary.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "propose",
    reason:
      "Governor proposal creation is intentionally public subject to governance proposal threshold checks.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "proposeSignal",
    reason:
      "Signal proposal creation is intentionally public subject to governance policy.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "castVote",
    reason: "Governor voting is intentionally public for token voters.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "castVoteWithReason",
    reason: "Governor voting is intentionally public for token voters.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "castVoteBySig",
    reason: "Governor public signature voting path.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "castVoteWithReasonAndParams",
    reason: "Governor voting is intentionally public for token voters.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "castVoteWithReasonAndParamsBySig",
    reason: "Governor public signature voting path.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "execute",
    reason:
      "Governor execution is public after proposal success and timelock readiness; invalid dummy calls must not mutate state.",
  },
  {
    contractName: "SethxGovernor",
    functionName: "cancel",
    reason:
      "Governor cancellation path is public but constrained by governance state/permissions.",
  },
  {
    contractName: "SethxTimelock",
    functionName: "execute",
    reason:
      "Timelock execution can be open after scheduling and delay; invalid dummy calls must not mutate state.",
  },
  {
    contractName: "SethxTimelock",
    functionName: "executeBatch",
    reason:
      "Timelock execution can be open after scheduling and delay; invalid dummy calls must not mutate state.",
  },

  {
    contractName: "SethxTimelock",
    functionName: "onERC721Received",
    reason:
      "ERC721 receiver hook is intentionally public so the timelock can safely receive NFTs; it returns only the receiver selector and grants no authority.",
  },
  {
    contractName: "SethxTimelock",
    functionName: "onERC1155Received",
    reason:
      "ERC1155 receiver hook is intentionally public so the timelock can safely receive tokens; it returns only the receiver selector and grants no authority.",
  },
  {
    contractName: "SethxTimelock",
    functionName: "onERC1155BatchReceived",
    reason:
      "ERC1155 batch receiver hook is intentionally public so the timelock can safely receive tokens; it returns only the receiver selector and grants no authority.",
  },
  {
    contractName: "AccountFactory",
    functionName: "createAccount",
    reason:
      "Account creation is an intentionally public entry point; the factory performs the privileged registry write internally.",
  },
  {
    contractName: "LendingAccountFactory",
    functionName: "createLendingAccount",
    reason:
      "LendingAccount creation is an intentionally public entry point; the factory performs the privileged registry write internally.",
  },
  {
    contractName: "PriceManager",
    functionName: "fetchPrice",
    reason:
      "Oracle refresh is intentionally public but constrained to approved oracles and cannot assign roles.",
  },
  {
    contractName: "PriceManager",
    functionName: "syncOracleData",
    reason:
      "Oracle data sync is intentionally public but constrained to approved oracles and cannot assign roles.",
  },
  {
    contractName: "SethxFeeConversionOracle",
    functionName: "fetchPrice",
    reason:
      "Static fee conversion oracle refresh/read path is intentionally public and cannot set the governance rate.",
  },
];

async function loadSweepTargets(): Promise<SweepTarget[]> {
  const deployment = readLocalDeployment();
  const targets: SweepTarget[] = [];

  for (const target of DEPLOYED_PROTOCOL_TARGETS) {
    const address = deployment.addresses[target.key];
    if (!address) continue;

    targets.push({
      key: target.key,
      contractName: target.contractName,
      address,
      contract: await ethers.getContractAt(target.contractName, address),
    });
  }

  return targets;
}

describe("Security baseline - deployed ABI malicious-call sweep", function () {
  it("enumerates every deployed external mutating protocol function", async function () {
    const targets = await loadSweepTargets();

    expect(
      targets.length,
      "expected deployed protocol targets",
    ).to.be.greaterThan(20);

    const rows = targets.flatMap((target) =>
      mutatingFragments(target.contract).map((fragment: any) => ({
        target: target.key,
        contractName: target.contractName,
        signature: fragment.format("sighash"),
        stateMutability: fragment.stateMutability,
      })),
    );

    expect(
      rows.length,
      "expected non-empty mutating ABI surface",
    ).to.be.greaterThan(100);
  });

  it("rejects unauthorized attacker calls or documents intentionally public surfaces", async function () {
    const targets = await loadSweepTargets();
    const actors = await loadActors(ethers);

    const results = await maliciousCallSweep({
      ethers,
      targets,
      attacker: actors.attacker,
      allowances: INTENTIONALLY_PUBLIC_OR_SELF_SERVICE,
    });

    const protectedReverts = results.filter(
      (result) => result.outcome === "reverted",
    );
    const allowedSuccesses = results.filter(
      (result) => result.outcome === "allowed-success",
    );

    expect(
      protectedReverts.length,
      "expected most protocol mutating calls to reject the attacker",
    ).to.be.greaterThan(80);

    expect(
      results.every((result) => result.outcome !== "unexpected-success"),
    ).to.equal(true);

    // Useful when this test is run with mocha's full reporter: the assertion keeps
    // the allowlist visible in the test body instead of hiding it in a helper.
    expect(
      allowedSuccesses.every((result) => Boolean(result.allowanceReason)),
      "every allowed successful attacker call must have a reason",
    ).to.equal(true);
  });
});
