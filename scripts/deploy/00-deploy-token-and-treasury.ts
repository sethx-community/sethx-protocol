export async function deployTokenAndTreasury(
  ethers: any,
  config: {
    founderAddress: string;
  },
  parameters: {
    token: {
      founderLockSeconds: bigint;
    };
  },
) {
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Missing latest block");

  const founderReleaseTime =
    BigInt(latestBlock.timestamp) + parameters.token.founderLockSeconds;

  const deployerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  const sethxToken = await ethers.deployContract("SethxToken", [
    deployerAddress,
  ]);
  await sethxToken.waitForDeployment();

  const founderTokenTimelock = await ethers.deployContract(
    "FounderTokenTimelock",
    [await sethxToken.getAddress(), config.founderAddress, founderReleaseTime],
  );
  await founderTokenTimelock.waitForDeployment();

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
    founderTokenTimelock,
    treasuryAuthority,
    protocolTreasury,
    addresses: {
      sethxToken: await sethxToken.getAddress(),
      founderTokenTimelock: await founderTokenTimelock.getAddress(),
      treasuryAuthority: await treasuryAuthority.getAddress(),
      protocolTreasury: await protocolTreasury.getAddress(),
    },
    founderReleaseTime,
  };
}
