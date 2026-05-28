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
    toBigIntValue(await feeManager.sethxDiscountBps()) !==
    BigInt(params.sethxDiscountBps)
  ) {
    const tx = await feeManager.setSethxDiscount(params.sethxDiscountBps);
    await tx.wait();
  }

  if (
    toBigIntValue(await feeManager.feeUpdateDelay()) !==
    BigInt(params.feeUpdateDelaySeconds)
  ) {
    const tx = await feeManager.setFeeUpdateDelay(params.feeUpdateDelaySeconds);
    await tx.wait();
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

  return {
    feeManager: {
      ethAccepted: await feeManager.isAcceptedFeeToken(ethers.ZeroAddress),
      sethxAccepted: await feeManager.isAcceptedFeeToken(
        deployment.addresses.sethxToken,
      ),
      sethxDiscountBps: (await feeManager.sethxDiscountBps()).toString(),
      feeUpdateDelay: (await feeManager.feeUpdateDelay()).toString(),
      contexts,
    },
  };
}
