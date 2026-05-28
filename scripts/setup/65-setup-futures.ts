export async function setupFutures(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      priceManager: string;
      futuresContract: string;
      futuresOrderBook: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const futuresContract = await ethers.getContractAt(
    "FuturesContract",
    deployment.addresses.futuresContract,
  );

  const futuresOrderBook = await ethers.getContractAt(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
  );

  if ((await futuresContract.priceManager()) !== deployment.addresses.priceManager) {
    const tx = await futuresContract.setPriceManager(
      deployment.addresses.priceManager,
    );
    await tx.wait();
  }

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const contractOrderbookRole = await futuresContract.ORDERBOOK_ROLE();
  const marketManagerRole = await futuresContract.MARKET_MANAGER_ROLE();
  const settlementManagerRole =
    await futuresContract.SETTLEMENT_MANAGER_ROLE();
  const orderBookSettlementManagerRole =
    await futuresOrderBook.SETTLEMENT_MANAGER_ROLE();

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.futuresContract,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.futuresContract,
    );
    await tx.wait();
  }

  if (
    !(await vault.hasRole(
      vaultOrderbookRole,
      deployment.addresses.futuresOrderBook,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.futuresOrderBook,
    );
    await tx.wait();
  }

  if (
    !(await futuresContract.hasRole(
      contractOrderbookRole,
      deployment.addresses.futuresOrderBook,
    ))
  ) {
    const tx = await futuresContract.grantRole(
      contractOrderbookRole,
      deployment.addresses.futuresOrderBook,
    );
    await tx.wait();
  }

  if (!(await futuresContract.hasRole(marketManagerRole, deployerAddress))) {
    const tx = await futuresContract.grantRole(
      marketManagerRole,
      deployerAddress,
    );
    await tx.wait();
  }

  if (
    !(await futuresContract.hasRole(settlementManagerRole, deployerAddress))
  ) {
    const tx = await futuresContract.grantRole(
      settlementManagerRole,
      deployerAddress,
    );
    await tx.wait();
  }

  if (
    !(await futuresOrderBook.hasRole(
      orderBookSettlementManagerRole,
      deployerAddress,
    ))
  ) {
    const tx = await futuresOrderBook.grantRole(
      orderBookSettlementManagerRole,
      deployerAddress,
    );
    await tx.wait();
  }

  return {
    roles: {
      futuresContract: {
        priceManager: true,
        vaultOrderbookRole: true,
        deployerMarketManagerRole: true,
        deployerSettlementManagerRole: true,
      },
      futuresOrderBook: {
        vaultOrderbookRole: true,
        futuresContractOrderbookRole: true,
        deployerSettlementManagerRole: true,
      },
    },
  };
}
