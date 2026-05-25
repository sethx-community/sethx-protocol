import type { DeploymentConfig } from "../config/types.js";
import {
  assertExpectedChainId,
  assertMainnetSafety,
} from "../config/guards.js";

const LOCAL_DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export async function deployTokenAndTreasury(
  ethers: any,
  config: DeploymentConfig,
) {
  await assertExpectedChainId(ethers, config);
  assertMainnetSafety(config);

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Missing latest block");

  const founderReleaseTime =
    BigInt(latestBlock.timestamp) + config.token.founderLockSeconds;

  const sethxToken = await ethers.deployContract("SethxToken", [
    LOCAL_DEPLOYER_ADDRESS,
  ]);
  await sethxToken.waitForDeployment();

  const founderTokenTimelock = await ethers.deployContract(
    "FounderTokenTimelock",
    [
      await sethxToken.getAddress(),
      config.token.founderAddress,
      founderReleaseTime,
    ],
  );
  await founderTokenTimelock.waitForDeployment();

  const treasuryAuthority = await ethers.deployContract("TreasuryAuthority", [
    LOCAL_DEPLOYER_ADDRESS,
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
