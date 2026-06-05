import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

async function impersonateLocalAccount(ethers: any, address: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x56BC75E2D63100000", // 100 ETH
  ]);

  return ethers.getSigner(address);
}

async function stopImpersonatingLocalAccount(ethers: any, address: string) {
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
}

async function mineToTimestamp(ethers: any, timestamp: bigint) {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("Latest block unavailable");

  const latest = BigInt(block.timestamp);
  if (latest >= timestamp) return;

  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${timestamp.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine", []);
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

function readLatestDeployment(outputDir = "deployments/local") {
  const file = path.resolve(process.cwd(), outputDir, "latest.json");

  if (!fs.existsSync(file)) {
    throw new Error(`Deployment file not found: ${file}`);
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const { ethers } = await network.connect();

  const deployment = readLatestDeployment(
    process.env.DEPLOYMENT_OUTPUT_DIR ?? "deployments/local",
  );

  const timelockAddress = deployment.addresses?.sethxTimelock;
  const feeManagerAddress = deployment.addresses?.feeManager;

  if (!timelockAddress) {
    throw new Error("Missing deployment.addresses.sethxTimelock");
  }

  if (!feeManagerAddress) {
    throw new Error("Missing deployment.addresses.feeManager");
  }

  const feeManager = await ethers.getContractAt(
    "FeeManager",
    feeManagerAddress,
  );

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest block not found");

  console.log("Timelock:", timelockAddress);
  console.log("FeeManager:", feeManagerAddress);
  console.log("Current timestamp:", latestBlock.timestamp.toString());

  const defaultAdminRole = await feeManager.DEFAULT_ADMIN_ROLE();

  const timelockHasAdmin = await feeManager.hasRole(
    defaultAdminRole,
    timelockAddress,
  );

  if (!timelockHasAdmin) {
    throw new Error("Timelock does not hold FeeManager DEFAULT_ADMIN_ROLE");
  }

  const timelockSigner = await impersonateLocalAccount(ethers, timelockAddress);

  try {
    const pendingDiscount = await feeManager.pendingSethxDiscountUpdate();

    if (toBigIntValue(pendingDiscount.executeAfter) > 0n) {
      const executeAfter = toBigIntValue(pendingDiscount.executeAfter);

      await mineToTimestamp(ethers, executeAfter);

      const tx = await feeManager
        .connect(timelockSigner)
        .executeSethxDiscountUpdate();

      await tx.wait();

      console.log("Executed SETHX discount update");
    } else {
      console.log("No pending SETHX discount update");
    }

    for (const context of INITIAL_PROTOCOL_PARAMETERS.feeManager.contexts) {
      const current = await feeManager.getRoleFeeConfig(context.context);

      const alreadyConfigured =
        current.configured === true &&
        toBigIntValue(current.makerFixedFee) === context.makerFixedFeeEth &&
        toBigIntValue(current.makerPercentageFee) ===
          BigInt(context.makerPercentageFeeBps) &&
        toBigIntValue(current.takerFixedFee) === context.takerFixedFeeEth &&
        toBigIntValue(current.takerPercentageFee) ===
          BigInt(context.takerPercentageFeeBps);

      if (alreadyConfigured) {
        console.log(`${context.context}: already configured`);
        continue;
      }

      const pending = await feeManager.pendingRoleUpdates(context.context);
      const executeAfter = toBigIntValue(pending.executeAfter);

      if (executeAfter === 0n) {
        console.log(`${context.context}: no pending update`);
        continue;
      }

      await mineToTimestamp(ethers, executeAfter);

      const tx = await feeManager
        .connect(timelockSigner)
        .executeRoleFeeUpdate(context.context);

      await tx.wait();

      const after = await feeManager.getRoleFeeConfig(context.context);

      console.log(`${context.context}: executed`, {
        makerFixedFee: after.makerFixedFee.toString(),
        makerPercentageFee: after.makerPercentageFee.toString(),
        takerFixedFee: after.takerFixedFee.toString(),
        takerPercentageFee: after.takerPercentageFee.toString(),
        configured: after.configured,
      });
    }
  } finally {
    await stopImpersonatingLocalAccount(ethers, timelockAddress);
  }

  const futures = await feeManager.getRoleFeeConfig("Futures Trade");

  console.log("Futures Trade final config:", {
    makerFixedFee: futures.makerFixedFee.toString(),
    makerPercentageFee: futures.makerPercentageFee.toString(),
    takerFixedFee: futures.takerFixedFee.toString(),
    takerPercentageFee: futures.takerPercentageFee.toString(),
    configured: futures.configured,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
