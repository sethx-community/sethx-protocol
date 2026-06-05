const BPS_DENOMINATOR = 10_000n;

export async function deployTokenAndTreasury(
  ethers: any,
  config: {
    founderAddresses: readonly string[];
  },
  parameters: {
    token: {
      totalSupply: bigint;
      founderTimelocks: readonly {
        founderIndex: number;
        releaseDelaySeconds: bigint;
        allocationBps: bigint;
      }[];
    };
  },
) {
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Missing latest block");

  if (config.founderAddresses.length !== 3) {
    throw new Error("Exactly three founder addresses are required");
  }

  if (parameters.token.founderTimelocks.length !== 6) {
    throw new Error("Exactly six founder timelocks are required");
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const sethxToken = await ethers.deployContract("SethxToken", [
    deployerAddress,
  ]);
  await sethxToken.waitForDeployment();

  const sethxTokenAddress = await sethxToken.getAddress();

  const founderTokenTimelocks = [];

  for (const [index, lock] of parameters.token.founderTimelocks.entries()) {
    const beneficiary = config.founderAddresses[lock.founderIndex];

    if (!beneficiary) {
      throw new Error(`Missing founder address for founder index ${lock.founderIndex}`);
    }

    const releaseTime =
      BigInt(latestBlock.timestamp) + lock.releaseDelaySeconds;
    const allocation =
      (parameters.token.totalSupply * lock.allocationBps) / BPS_DENOMINATOR;

    const contract = await ethers.deployContract("FounderTokenTimelock", [
      sethxTokenAddress,
      beneficiary,
      releaseTime,
    ]);
    await contract.waitForDeployment();

    founderTokenTimelocks.push({
      id: `founder-${lock.founderIndex + 1}-${lock.releaseDelaySeconds.toString()}s`,
      founderIndex: lock.founderIndex,
      beneficiary,
      releaseDelaySeconds: lock.releaseDelaySeconds,
      releaseTime,
      allocationBps: lock.allocationBps,
      allocation,
      contract,
      address: await contract.getAddress(),
    });

    console.log(
      `Founder timelock ${index + 1}/6 deployed for ${beneficiary}: ${await contract.getAddress()}`,
    );
  }

  const treasuryAuthority = await ethers.deployContract("TreasuryAuthority", [
    deployerAddress,
  ]);
  await treasuryAuthority.waitForDeployment();

  const protocolTreasury = await ethers.deployContract("ProtocolTreasury", [
    await treasuryAuthority.getAddress(),
  ]);
  await protocolTreasury.waitForDeployment();

  return {
    sethxToken,
    founderTokenTimelocks,
    treasuryAuthority,
    protocolTreasury,
    addresses: {
      sethxToken: sethxTokenAddress,
      founderTokenTimelocks: founderTokenTimelocks.map((lock) => ({
        id: lock.id,
        founderIndex: lock.founderIndex,
        beneficiary: lock.beneficiary,
        releaseDelaySeconds: lock.releaseDelaySeconds,
        releaseTime: lock.releaseTime,
        allocationBps: lock.allocationBps,
        allocation: lock.allocation,
        address: lock.address,
      })),
      treasuryAuthority: await treasuryAuthority.getAddress(),
      protocolTreasury: await protocolTreasury.getAddress(),
    },
  };
}
