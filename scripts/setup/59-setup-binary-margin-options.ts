export async function setupBinaryMarginOptions(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      priceManager: string;
      binaryMarginOptionContract: string;
      binaryMarginOptionsOrderBook: string;
    };
  },
  parameters: {
    binaryMarginOptions?: {
      settlementPriceMaxWaitSeconds?: number | bigint;
    };
  } = {},
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const binaryMarginOptionContract = await ethers.getContractAt(
    "BinaryMarginOptionContract",
    deployment.addresses.binaryMarginOptionContract,
  );

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const contractOrderbookRole =
    await binaryMarginOptionContract.ORDERBOOK_ROLE();
  const marketManagerRole =
    await binaryMarginOptionContract.MARKET_MANAGER_ROLE();

  const currentPriceManager = await binaryMarginOptionContract.priceManager();
  if (ethers.getAddress(currentPriceManager) !== ethers.getAddress(deployment.addresses.priceManager)) {
    const tx = await binaryMarginOptionContract.setPriceManager(
      deployment.addresses.priceManager,
    );
    await tx.wait();
  }

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.binaryMarginOptionContract,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.binaryMarginOptionContract,
    );
    await tx.wait();
  }

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.binaryMarginOptionsOrderBook,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.binaryMarginOptionsOrderBook,
    );
    await tx.wait();
  }

  if (
    !(await binaryMarginOptionContract.hasRole(
      contractOrderbookRole,
      deployment.addresses.binaryMarginOptionsOrderBook,
    ))
  ) {
    const tx = await binaryMarginOptionContract.grantRole(
      contractOrderbookRole,
      deployment.addresses.binaryMarginOptionsOrderBook,
    );
    await tx.wait();
  }

  if (
    !(await binaryMarginOptionContract.hasRole(
      marketManagerRole,
      deployerAddress,
    ))
  ) {
    const tx = await binaryMarginOptionContract.grantRole(
      marketManagerRole,
      deployerAddress,
    );
    await tx.wait();
  }



  const settlementPriceMaxWaitSeconds =
    parameters.binaryMarginOptions?.settlementPriceMaxWaitSeconds;
  if (settlementPriceMaxWaitSeconds !== undefined) {
    const desiredWait = BigInt(settlementPriceMaxWaitSeconds);
    const currentWait = await binaryMarginOptionContract.settlementPriceMaxWait();
    if (currentWait !== desiredWait) {
      const tx = await binaryMarginOptionContract.setSettlementPriceMaxWait(desiredWait);
      await tx.wait();
    }
  }

  return {
    roles: {
      binaryMarginOptionContract: {
        vaultOrderbookRole: true,
        priceManager: deployment.addresses.priceManager,
        deployerMarketManagerRole: true,
      },
      binaryMarginOptionsOrderBook: {
        vaultOrderbookRole: true,
        binaryMarginOptionContractOrderbookRole: true,
      },
    },
  };
}
