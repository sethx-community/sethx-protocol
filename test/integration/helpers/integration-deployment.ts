import { INITIAL_PROTOCOL_PARAMETERS } from "../../../scripts/parameters/initial-protocol-parameters.js";

import {
  readLocalDeployment,
  requireLocalAddress,
} from "../../helpers/deployment-reader.js";

export async function loadIntegratedDeployment(ethers: any) {
  const deployment = readLocalDeployment();

  const addresses = {
    sethxToken: requireLocalAddress(deployment, "sethxToken"),
    protocolTreasury: requireLocalAddress(deployment, "protocolTreasury"),
    treasuryAuthority: requireLocalAddress(deployment, "treasuryAuthority"),
    accountRegistry: requireLocalAddress(deployment, "accountRegistry"),
    sethxVault: requireLocalAddress(deployment, "sethxVault"),
    accountFactory: requireLocalAddress(deployment, "accountFactory"),
    lendingAccountFactory: requireLocalAddress(
      deployment,
      "lendingAccountFactory",
    ),
    feeManager: requireLocalAddress(deployment, "feeManager"),
    priceManager: requireLocalAddress(deployment, "priceManager"),
    tokenSpotOrderBook: requireLocalAddress(deployment, "tokenSpotOrderBook"),
    nftSpotOrderBook: requireLocalAddress(deployment, "nftSpotOrderBook"),
    optionContract: requireLocalAddress(deployment, "optionContract"),
    optionsOrderBook: requireLocalAddress(deployment, "optionsOrderBook"),
    marginOptionContract: requireLocalAddress(deployment, "marginOptionContract"),
    marginOptionsOrderBook: requireLocalAddress(deployment, "marginOptionsOrderBook"),
    binaryMarginOptionContract: requireLocalAddress(
      deployment,
      "binaryMarginOptionContract",
    ),
    binaryMarginOptionsOrderBook: requireLocalAddress(
      deployment,
      "binaryMarginOptionsOrderBook",
    ),
    futuresContract: requireLocalAddress(deployment, "futuresContract"),
    futuresOrderBook: requireLocalAddress(deployment, "futuresOrderBook"),
    settlementManager: requireLocalAddress(deployment, "settlementManager"),
    lendingContract: requireLocalAddress(deployment, "lendingContract"),
    lendingOrderBook: requireLocalAddress(deployment, "lendingOrderBook"),
    riskModule: requireLocalAddress(deployment, "riskModule"),
    valuationModule: requireLocalAddress(deployment, "valuationModule"),
    liquidationEngine: requireLocalAddress(deployment, "liquidationEngine"),
    sethxTimelock: requireLocalAddress(deployment, "sethxTimelock"),
    sethxGovernor: requireLocalAddress(deployment, "sethxGovernor"),
    sethxFeeConversionOracle: requireLocalAddress(
      deployment,
      "sethxFeeConversionOracle",
    ),
    passiveFuturesSnapshotPublisher: requireLocalAddress(
      deployment,
      "passiveFuturesSnapshotPublisher",
    ),
    passiveFuturesPoolFactory: requireLocalAddress(
      deployment,
      "passiveFuturesPoolFactory",
    ),
  };

  const contracts = {
    sethxToken: await ethers.getContractAt("SethxToken", addresses.sethxToken),
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
    feeManager: await ethers.getContractAt("FeeManager", addresses.feeManager),
    priceManager: await ethers.getContractAt(
      "PriceManager",
      addresses.priceManager,
    ),
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
    sethxFeeConversionOracle: await ethers.getContractAt(
      "SethxFeeConversionOracle",
      addresses.sethxFeeConversionOracle,
    ),
    passiveFuturesSnapshotPublisher: await ethers.getContractAt(
      "PassiveFuturesSnapshotPublisher",
      addresses.passiveFuturesSnapshotPublisher,
    ),
    passiveFuturesPoolFactory: await ethers.getContractAt(
      "PassiveFuturesPoolFactory",
      addresses.passiveFuturesPoolFactory,
    ),
    treasuryAuthority: await ethers.getContractAt(
      "TreasuryAuthority",
      addresses.treasuryAuthority,
    ),
  };

  return {
    deployment,
    addresses,
    contracts,
  };
}

export async function loadActors(ethers: any) {
  const signers = await ethers.getSigners();
  const configuredTreasurer = ethers.getAddress(
    INITIAL_PROTOCOL_PARAMETERS.treasury.initialTreasurer,
  );

  let treasurer = signers[5];
  for (const signer of signers) {
    if (ethers.getAddress(await signer.getAddress()) === configuredTreasurer) {
      treasurer = signer;
      break;
    }
  }

  return {
    deployer: signers[0],
    governorOperator: signers[0],
    alice: signers[1],
    bob: signers[2],
    carol: signers[3],
    dave: signers[4],
    treasurer,
    attacker: signers[6],
    lp1: signers[7],
    lp2: signers[8],
  };
}
