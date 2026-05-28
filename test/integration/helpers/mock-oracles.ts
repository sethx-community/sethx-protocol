export type MockOracleSet = {
  ethUsd: any;
  btcUsd: any;
  tokenAUsd: any;
  tokenBUsd: any;
};

export async function deployMockOracles(ethers: any): Promise<MockOracleSet> {
  const ethUsd = await ethers.deployContract("MockPriceOracle", [
    "ETH/USD",
    8,
    3_000n * 10n ** 8n,
  ]);
  await ethUsd.waitForDeployment();

  const btcUsd = await ethers.deployContract("MockPriceOracle", [
    "BTC/USD",
    8,
    100_000n * 10n ** 8n,
  ]);
  await btcUsd.waitForDeployment();

  const tokenAUsd = await ethers.deployContract("MockPriceOracle", [
    "MTKA/USD",
    8,
    10n * 10n ** 8n,
  ]);
  await tokenAUsd.waitForDeployment();

  const tokenBUsd = await ethers.deployContract("MockPriceOracle", [
    "MTKB/USD",
    8,
    25n * 10n ** 8n,
  ]);
  await tokenBUsd.waitForDeployment();

  return {
    ethUsd,
    btcUsd,
    tokenAUsd,
    tokenBUsd,
  };
}

export async function setOraclePrice(oracle: any, price: bigint) {
  const tx = await oracle.setPrice(price);
  await tx.wait();
}
