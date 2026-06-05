import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { getMainnetDeploymentConfig } from "../config/mainnet.js";
import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";
import { writeDeploymentOutput } from "../output/write-deployment.js";

const BPS_DENOMINATOR = 10_000n;

const RECOVERED_TOKEN_ADDRESS = "0xd603b12f7458d44ddf30e48e72c640c9b6f9d61f";

const RECOVERED_TOKEN_TX =
  "0x34a2368a7f1b39245876cc005e680d0bc33682684632ff8b63e4cf0f5c190afe";

const RECOVERED_FIRST_TIMELOCK_TX =
  "0x17a326a95ea593101da2905b94bea4941c8b882e608c226c4b8f59da3bc0ebe4";

const RECOVERED_FIRST_TIMELOCK_ADDRESS =
  "0x0eb8ad5a29e8b0b9d8bc881b0616cdfd18dbab5c";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function latestDeploymentPath(outputDir: string) {
  return path.join(outputDir, "latest.json");
}

function hexToBigInt(value: string): bigint {
  return BigInt(value);
}

async function getReceipt(provider: any, txHash: string) {
  const receipt = await provider.send("eth_getTransactionReceipt", [txHash]);
  if (!receipt) {
    throw new Error(`Missing receipt for ${txHash}`);
  }
  if (receipt.status !== "0x1") {
    throw new Error(`Transaction failed: ${txHash}`);
  }
  if (!receipt.contractAddress) {
    throw new Error(`Receipt has no contractAddress: ${txHash}`);
  }
  return receipt;
}

async function getBlockTimestamp(
  provider: any,
  blockNumberHex: string,
): Promise<bigint> {
  const block = await provider.send("eth_getBlockByNumber", [
    blockNumberHex,
    false,
  ]);
  if (!block?.timestamp) {
    throw new Error(`Could not read block timestamp for ${blockNumberHex}`);
  }
  return hexToBigInt(block.timestamp);
}

async function waitForReceipt(provider: any, txHash: string) {
  for (;;) {
    const receipt = await provider.send("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(`Transaction failed: ${txHash}`);
      }
      if (!receipt.contractAddress) {
        throw new Error(`Deployment tx has no contractAddress: ${txHash}`);
      }
      return receipt;
    }

    await new Promise((resolve) => setTimeout(resolve, 12_000));
  }
}

async function deployRaw(
  ethers: any,
  provider: any,
  wallet: any,
  name: string,
  args: unknown[],
) {
  const deployerAddress = await wallet.getAddress();
  const factory = await ethers.getContractFactory(name);
  const deployTx = await factory.getDeployTransaction(...args);

  if (!deployTx.data) {
    throw new Error(`Missing deployment data for ${name}`);
  }

  const nonceHex = await provider.send("eth_getTransactionCount", [
    deployerAddress,
    "pending",
  ]);
  const nonce = Number(hexToBigInt(nonceHex));

  const predictedAddress = ethers.getCreateAddress({
    from: deployerAddress,
    nonce,
  });

  const feeData = await ethers.provider.getFeeData();

  const gasEstimate = await ethers.provider.estimateGas({
    from: deployerAddress,
    data: deployTx.data,
    value: 0n,
  });

  const gasLimit = (gasEstimate * 120n) / 100n;

  const tx = {
    type: 2,
    chainId: 1,
    nonce,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas ?? feeData.gasPrice,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
    data: deployTx.data,
    value: 0n,
  };

  if (!tx.maxFeePerGas) {
    throw new Error("Could not determine maxFeePerGas");
  }

  const signed = await wallet.signTransaction(tx);
  const hash = await provider.send("eth_sendRawTransaction", [signed]);

  console.log(`${name} deployment sent: ${hash}`);
  console.log(`${name} predicted address: ${predictedAddress}`);

  const receipt = await waitForReceipt(provider, hash);

  if (
    receipt.contractAddress.toLowerCase() !== predictedAddress.toLowerCase()
  ) {
    throw new Error(
      `${name} address mismatch. Predicted ${predictedAddress}, receipt ${receipt.contractAddress}`,
    );
  }

  console.log(`${name} deployed: ${receipt.contractAddress}`);

  return {
    address: receipt.contractAddress as string,
    txHash: hash as string,
  };
}

async function main() {
  const config = getMainnetDeploymentConfig();
  const { ethers } = await network.connect("mainnet");
  const provider = ethers.provider;

  const latestPath = latestDeploymentPath(config.outputDir);
  if (fs.existsSync(latestPath)) {
    throw new Error(
      `Deployment output already exists at ${latestPath}. Refusing to overwrite.`,
    );
  }

  const chain = await provider.getNetwork();
  if (chain.chainId !== config.expectedChainId) {
    throw new Error(
      `Wrong chain ID. Expected ${config.expectedChainId}, got ${chain.chainId}`,
    );
  }

  const privateKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const wallet = new ethers.Wallet(privateKey);
  const deployerAddress = await wallet.getAddress();

  const tokenReceipt = await getReceipt(provider, RECOVERED_TOKEN_TX);
  if (
    tokenReceipt.contractAddress.toLowerCase() !==
    RECOVERED_TOKEN_ADDRESS.toLowerCase()
  ) {
    throw new Error("Recovered token address does not match token receipt");
  }

  const firstLockReceipt = await getReceipt(
    provider,
    RECOVERED_FIRST_TIMELOCK_TX,
  );
  if (
    firstLockReceipt.contractAddress.toLowerCase() !==
    RECOVERED_FIRST_TIMELOCK_ADDRESS.toLowerCase()
  ) {
    throw new Error("Recovered first timelock address does not match receipt");
  }

  const tokenDeploymentTimestamp = await getBlockTimestamp(
    provider,
    tokenReceipt.blockNumber,
  );

  const sethxToken = await ethers.getContractAt(
    "SethxToken",
    RECOVERED_TOKEN_ADDRESS,
  );

  const minter = await sethxToken.minter();
  if (minter.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Recovered token minter is ${minter}, expected ${deployerAddress}`,
    );
  }

  const totalSupply = await sethxToken.totalSupply();
  if (totalSupply !== 0n) {
    throw new Error(
      `Recovered token totalSupply is ${totalSupply.toString()}, expected 0 before stage 10`,
    );
  }

  const founderTokenTimelocks: any[] = [];

  for (const [
    index,
    lock,
  ] of INITIAL_PROTOCOL_PARAMETERS.token.founderTimelocks.entries()) {
    const beneficiary = config.founderAddresses[lock.founderIndex];
    if (!beneficiary) {
      throw new Error(`Missing founder address for index ${lock.founderIndex}`);
    }

    const releaseTime = tokenDeploymentTimestamp + lock.releaseDelaySeconds;
    const allocation =
      (INITIAL_PROTOCOL_PARAMETERS.token.totalSupply * lock.allocationBps) /
      BPS_DENOMINATOR;

    let address: string;

    if (index === 0) {
      address = RECOVERED_FIRST_TIMELOCK_ADDRESS;
      console.log(`Using recovered founder timelock 1: ${address}`);
    } else {
      const deployed = await deployRaw(
        ethers,
        provider,
        wallet,
        "FounderTokenTimelock",
        [RECOVERED_TOKEN_ADDRESS, beneficiary, releaseTime],
      );
      address = deployed.address;
    }

    founderTokenTimelocks.push({
      id: `founder-${lock.founderIndex + 1}-${lock.releaseDelaySeconds.toString()}s`,
      founderIndex: lock.founderIndex,
      beneficiary,
      releaseDelaySeconds: lock.releaseDelaySeconds,
      releaseTime,
      allocationBps: lock.allocationBps,
      allocation,
      address,
    });
  }

  const treasuryAuthorityDeployment = await deployRaw(
    ethers,
    provider,
    wallet,
    "TreasuryAuthority",
    [deployerAddress],
  );

  const protocolTreasuryDeployment = await deployRaw(
    ethers,
    provider,
    wallet,
    "ProtocolTreasury",
    [treasuryAuthorityDeployment.address],
  );

  const deployedAt = new Date(
    Number(tokenDeploymentTimestamp) * 1000,
  ).toISOString();

  const output = {
    environment: config.environment,
    chainId: chain.chainId,
    deployedAt,
    founderAddresses: config.founderAddresses,
    addresses: {
      sethxToken: RECOVERED_TOKEN_ADDRESS,
      founderTokenTimelocks,
      treasuryAuthority: treasuryAuthorityDeployment.address,
      protocolTreasury: protocolTreasuryDeployment.address,
    },
    updatedAt: new Date().toISOString(),
    recovery: {
      recoveredFromTokenDeploymentTx: RECOVERED_TOKEN_TX,
      recoveredSethxToken: RECOVERED_TOKEN_ADDRESS,
      recoveredFirstFounderTimelockTx: RECOVERED_FIRST_TIMELOCK_TX,
      recoveredFirstFounderTimelock: RECOVERED_FIRST_TIMELOCK_ADDRESS,
      recoveredAt: new Date().toISOString(),
    },
    stages: {
      "00": {
        completedAt: new Date().toISOString(),
        description:
          "Recovered stage 00 from existing token and first founder timelock; raw-deployed remaining founder timelocks, TreasuryAuthority, and ProtocolTreasury",
      },
    },
  };

  writeDeploymentOutput(config.outputDir, output);

  console.log("Recovered mainnet stage 00 successfully");
  console.log(`SETHX token: ${RECOVERED_TOKEN_ADDRESS}`);
  console.log(`Founder timelocks: ${founderTokenTimelocks.length}`);
  console.log(`TreasuryAuthority: ${treasuryAuthorityDeployment.address}`);
  console.log(`ProtocolTreasury: ${protocolTreasuryDeployment.address}`);
}

await main();
