async function wait(txPromise: Promise<any>) {
  const tx = await txPromise;
  await tx.wait();
  return tx;
}

export async function setupTokenDistribution(
  parameters: {
    token: {
      totalSupply: bigint;
      founderAllocation: bigint;
      treasuryAllocation: bigint;
    };
  },
  deployment: {
    sethxToken: any;
    addresses: {
      founderTokenTimelocks: readonly {
        address: string;
        allocation: bigint;
      }[];
      protocolTreasury: string;
    };
  },
) {
  const totalSupply = parameters.token.totalSupply;
  const founderAmount = parameters.token.founderAllocation;
  const treasuryAmount = parameters.token.treasuryAllocation;

  if (totalSupply <= 0n) throw new Error("Total supply is zero");
  if (founderAmount <= 0n) throw new Error("Founder allocation is zero");
  if (treasuryAmount <= 0n) throw new Error("Treasury allocation is zero");

  if (deployment.addresses.founderTokenTimelocks.length !== 6) {
    throw new Error("Expected six founder timelocks");
  }

  const founderTimelockTotal = deployment.addresses.founderTokenTimelocks.reduce(
    (sum, lock) => sum + lock.allocation,
    0n,
  );

  if (founderTimelockTotal !== founderAmount) {
    throw new Error(
      "Founder timelock allocations do not sum to founder allocation",
    );
  }

  if (founderAmount + treasuryAmount !== totalSupply) {
    throw new Error(
      "Founder and treasury allocations do not sum to total supply",
    );
  }

  const mintingFinished = await deployment.sethxToken.mintingFinished();
  if (mintingFinished) {
    const currentTotalSupply = await deployment.sethxToken.totalSupply();
    if (currentTotalSupply !== totalSupply) {
      throw new Error(
        `Minting is finished but total supply is ${currentTotalSupply}; expected ${totalSupply}`,
      );
    }
  }

  const treasuryBalance = await deployment.sethxToken.balanceOf(
    deployment.addresses.protocolTreasury,
  );

  if (treasuryBalance > treasuryAmount) {
    throw new Error(
      `Treasury balance exceeds expected allocation. Expected ${treasuryAmount}, got ${treasuryBalance}`,
    );
  }

  if (!mintingFinished && treasuryBalance < treasuryAmount) {
    const missing = treasuryAmount - treasuryBalance;
    await wait(
      deployment.sethxToken.mint(deployment.addresses.protocolTreasury, missing, {
        gasLimit: 150_000n,
      }),
    );
  }

  for (const lock of deployment.addresses.founderTokenTimelocks) {
    if (lock.allocation <= 0n) {
      throw new Error("Founder timelock allocation is zero");
    }

    const current = await deployment.sethxToken.balanceOf(lock.address);
    if (current > lock.allocation) {
      throw new Error(
        `Founder timelock ${lock.address} balance exceeds expected allocation. Expected ${lock.allocation}, got ${current}`,
      );
    }

    if (!mintingFinished && current < lock.allocation) {
      const missing = lock.allocation - current;
      await wait(
        deployment.sethxToken.mint(lock.address, missing, {
          gasLimit: 150_000n,
        }),
      );
    }
  }

  const finalTotalBeforeFinish = await deployment.sethxToken.totalSupply();
  if (finalTotalBeforeFinish !== totalSupply) {
    throw new Error(
      `Unexpected total supply before finish. Expected ${totalSupply}, got ${finalTotalBeforeFinish}`,
    );
  }

  if (!mintingFinished) {
    await wait(
      deployment.sethxToken.finishMinting({
        gasLimit: 120_000n,
      }),
    );
  }

  const finalMinter = await deployment.sethxToken.minter();
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  if (finalMinter.toLowerCase() !== zeroAddress) {
    throw new Error(`Final minter is not zero: ${finalMinter}`);
  }

  return {
    totalSupply,
    founderAmount,
    founderTimelockTotal,
    founderTimelocks: deployment.addresses.founderTokenTimelocks.map((lock) => ({
      address: lock.address,
      allocation: lock.allocation,
    })),
    treasuryAmount,
  };
}
