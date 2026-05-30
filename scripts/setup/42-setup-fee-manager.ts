import { INITIAL_PROTOCOL_PARAMETERS } from "../parameters/initial-protocol-parameters.js";

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

export async function setupFeeManager(
  ethers: any,
  deployment: {
    addresses: {
      feeManager: string;
      sethxToken: string;
    };
  },
) {
  const params = INITIAL_PROTOCOL_PARAMETERS.feeManager;

  const feeManager = await ethers.getContractAt(
    "FeeManager",
    deployment.addresses.feeManager,
  );

  if (
    (await feeManager.isAcceptedFeeToken(ethers.ZeroAddress)) !==
    params.acceptEthFees
  ) {
    const tx = await feeManager.setETHAsAcceptedFeeToken(params.acceptEthFees);
    await tx.wait();
  }

  if (
    (await feeManager.isAcceptedFeeToken(deployment.addresses.sethxToken)) !==
    params.acceptSethxFees
  ) {
    const tx = await feeManager.setAcceptedFeeToken(
      deployment.addresses.sethxToken,
      params.acceptSethxFees,
    );
    await tx.wait();
  }

  if (
    toBigIntValue(await feeManager.feeUpdateDelay()) !==
    BigInt(params.feeUpdateDelaySeconds)
  ) {
    const tx = await feeManager.setFeeUpdateDelay(params.feeUpdateDelaySeconds);
    await tx.wait();
  }

  const currentSethxDiscount = toBigIntValue(
    await feeManager.sethxDiscountBps(),
  );
  let sethxDiscountStatus = "configured";

  if (currentSethxDiscount !== BigInt(params.sethxDiscountBps)) {
    const pendingBefore = await feeManager.pendingSethxDiscountUpdate();
    const pendingMatches =
      toBigIntValue(pendingBefore.discountBps) ===
        BigInt(params.sethxDiscountBps) &&
      toBigIntValue(pendingBefore.executeAfter) > 0n;

    if (!pendingMatches) {
      const tx = await feeManager.queueSethxDiscountUpdate(
        params.sethxDiscountBps,
      );
      await tx.wait();
    }

    sethxDiscountStatus = "queued";
  }

  const contexts: Record<string, unknown>[] = [];

  for (const context of params.contexts) {
    const current = await feeManager.roleFeeConfigs(context.context);

    const alreadyConfigured =
      current.configured === true &&
      toBigIntValue(current.makerFixedFee) === context.makerFixedFeeEth &&
      toBigIntValue(current.makerPercentageFee) ===
        BigInt(context.makerPercentageFeeBps) &&
      toBigIntValue(current.takerFixedFee) === context.takerFixedFeeEth &&
      toBigIntValue(current.takerPercentageFee) ===
        BigInt(context.takerPercentageFeeBps);

    if (alreadyConfigured) {
      contexts.push({
        context: context.context,
        status: "configured",
      });
      continue;
    }

    const pendingBefore = await feeManager.pendingRoleUpdates(context.context);

    const pendingMatches =
      toBigIntValue(pendingBefore.makerFixedFee) === context.makerFixedFeeEth &&
      toBigIntValue(pendingBefore.makerPercentageFee) ===
        BigInt(context.makerPercentageFeeBps) &&
      toBigIntValue(pendingBefore.takerFixedFee) === context.takerFixedFeeEth &&
      toBigIntValue(pendingBefore.takerPercentageFee) ===
        BigInt(context.takerPercentageFeeBps) &&
      toBigIntValue(pendingBefore.executeAfter) > 0n;

    if (!pendingMatches) {
      const tx = await feeManager.queueRoleFeeUpdate(
        context.context,
        context.makerFixedFeeEth,
        context.makerPercentageFeeBps,
        context.takerFixedFeeEth,
        context.takerPercentageFeeBps,
      );
      await tx.wait();
    }

    const pendingAfter = await feeManager.pendingRoleUpdates(context.context);

    contexts.push({
      context: context.context,
      status: "queued",
      makerFixedFee: pendingAfter.makerFixedFee.toString(),
      makerPercentageFee: pendingAfter.makerPercentageFee.toString(),
      takerFixedFee: pendingAfter.takerFixedFee.toString(),
      takerPercentageFee: pendingAfter.takerPercentageFee.toString(),
      executeAfter: pendingAfter.executeAfter.toString(),
    });
  }

  const pendingSethxDiscount = await feeManager.pendingSethxDiscountUpdate();

  return {
    feeManager: {
      ethAccepted: await feeManager.isAcceptedFeeToken(ethers.ZeroAddress),
      sethxAccepted: await feeManager.isAcceptedFeeToken(
        deployment.addresses.sethxToken,
      ),
      sethxDiscountBps: (await feeManager.sethxDiscountBps()).toString(),
      pendingSethxDiscountBps: pendingSethxDiscount.discountBps.toString(),
      pendingSethxDiscountExecuteAfter:
        pendingSethxDiscount.executeAfter.toString(),
      sethxDiscountStatus,
      feeUpdateDelay: (await feeManager.feeUpdateDelay()).toString(),
      contexts,
    },
  };
}
