export async function impersonateLocalAccount(ethers: any, address: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x56BC75E2D63100000", // 100 ETH
  ]);

  return ethers.getSigner(address);
}

export async function stopImpersonatingLocalAccount(
  ethers: any,
  address: string,
) {
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
}

export async function impersonateTimelock(ethers: any, timelock: string) {
  return impersonateLocalAccount(ethers, timelock);
}
