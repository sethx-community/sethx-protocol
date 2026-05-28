export type MockTokenSet = {
  usdc: any;
  wbtc: any;
  wethLike: any;
  tokenA: any;
  tokenB: any;
  feeOnTransferToken: any;
  nft: any;
};

export async function deployMockAssets(ethers: any): Promise<MockTokenSet> {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const usdc = await ethers.deployContract("MockERC20", [
    "Mock USDC",
    "mUSDC",
    6,
  ]);
  await usdc.waitForDeployment();

  const wbtc = await ethers.deployContract("MockERC20", [
    "Mock WBTC",
    "mWBTC",
    8,
  ]);
  await wbtc.waitForDeployment();

  const wethLike = await ethers.deployContract("MockERC20", [
    "Mock WETH",
    "mWETH",
    18,
  ]);
  await wethLike.waitForDeployment();

  const tokenA = await ethers.deployContract("MockERC20", [
    "Mock Token A",
    "MTKA",
    18,
  ]);
  await tokenA.waitForDeployment();

  const tokenB = await ethers.deployContract("MockERC20", [
    "Mock Token B",
    "MTKB",
    18,
  ]);
  await tokenB.waitForDeployment();

  const feeOnTransferToken = await ethers.deployContract(
    "MockFeeOnTransferERC20",
    ["Fee Token", "FEE", 18, 100, deployerAddress],
  );
  await feeOnTransferToken.waitForDeployment();

  const nft = await ethers.deployContract("MockERC721", ["Mock NFT", "MNFT"]);
  await nft.waitForDeployment();

  return {
    usdc,
    wbtc,
    wethLike,
    tokenA,
    tokenB,
    feeOnTransferToken,
    nft,
  };
}

export async function mintMockBalances(
  ethers: any,
  tokens: MockTokenSet,
  recipients: string[],
) {
  const amount18 = ethers.parseEther("1000000");
  const amount6 = 1_000_000_000_000n; // 1,000,000 with 6 decimals
  const amount8 = 100_000_000_000_000n; // 1,000,000 with 8 decimals

  for (const recipient of recipients) {
    await (await tokens.usdc.mint(recipient, amount6)).wait();
    await (await tokens.wbtc.mint(recipient, amount8)).wait();
    await (await tokens.wethLike.mint(recipient, amount18)).wait();
    await (await tokens.tokenA.mint(recipient, amount18)).wait();
    await (await tokens.tokenB.mint(recipient, amount18)).wait();
    await (await tokens.feeOnTransferToken.mint(recipient, amount18)).wait();

    await (await tokens.nft.mint(recipient)).wait();
    await (await tokens.nft.mint(recipient)).wait();
  }
}
