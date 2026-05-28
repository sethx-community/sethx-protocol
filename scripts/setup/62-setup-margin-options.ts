export async function setupMarginOptions(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      priceManager: string;
      marginOptionContract: string;
      marginOptionsOrderBook: string;
    };
  },
  parameters: {
    marginOptions?: {
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

  const marginOptionContract = await ethers.getContractAt(
    "MarginOptionContract",
    deployment.addresses.marginOptionContract,
  );

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const contractOrderbookRole = await marginOptionContract.ORDERBOOK_ROLE();
  const marketManagerRole = await marginOptionContract.MARKET_MANAGER_ROLE();

  const currentPriceManager = await marginOptionContract.priceManager();
  if (ethers.getAddress(currentPriceManager) !== ethers.getAddress(deployment.addresses.priceManager)) {
    const tx = await marginOptionContract.setPriceManager(
      deployment.addresses.priceManager,
    );
    await tx.wait();
  }

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.marginOptionContract,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.marginOptionContract,
    );
    await tx.wait();
  }

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.marginOptionsOrderBook,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.marginOptionsOrderBook,
    );
    await tx.wait();
  }

  if (
    !(await marginOptionContract.hasRole(
      contractOrderbookRole,
      deployment.addresses.marginOptionsOrderBook,
    ))
  ) {
    const tx = await marginOptionContract.grantRole(
      contractOrderbookRole,
      deployment.addresses.marginOptionsOrderBook,
    );
    await tx.wait();
  }

  if (
    !(await marginOptionContract.hasRole(marketManagerRole, deployerAddress))
  ) {
    const tx = await marginOptionContract.grantRole(
      marketManagerRole,
      deployerAddress,
    );
    await tx.wait();
  }



  const settlementPriceMaxWaitSeconds =
    parameters.marginOptions?.settlementPriceMaxWaitSeconds;
  if (settlementPriceMaxWaitSeconds !== undefined) {
    const desiredWait = BigInt(settlementPriceMaxWaitSeconds);
    const currentWait = await marginOptionContract.settlementPriceMaxWait();
    if (currentWait !== desiredWait) {
      const tx = await marginOptionContract.setSettlementPriceMaxWait(desiredWait);
      await tx.wait();
    }
  }

  return {
    roles: {
      marginOptionContract: {
        vaultOrderbookRole: true,
        priceManager: deployment.addresses.priceManager,
        deployerMarketManagerRole: true,
      },
      marginOptionsOrderBook: {
        vaultOrderbookRole: true,
        marginOptionContractOrderbookRole: true,
      },
    },
  };
}
