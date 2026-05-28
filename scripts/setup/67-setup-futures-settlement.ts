export async function setupFuturesSettlement(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      futuresContract: string;
      futuresOrderBook: string;
      settlementManager: string;
    };
  },
) {
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

  const settlementManager = await ethers.getContractAt(
    "SettlementManager",
    deployment.addresses.settlementManager,
  );

  const vaultSettlementRole = await vault.SETTLEMENT_ROLE();
  const futuresSettlementRole = await futuresContract.SETTLEMENT_MANAGER_ROLE();
  const futuresMarketManagerRole = await futuresContract.MARKET_MANAGER_ROLE();
  const orderBookSettlementRole = await futuresOrderBook.SETTLEMENT_MANAGER_ROLE();

  if (!(await vault.hasRole(vaultSettlementRole, deployment.addresses.settlementManager))) {
    const tx = await vault.grantRole(
      vaultSettlementRole,
      deployment.addresses.settlementManager,
    );
    await tx.wait();
  }

  if (!(await futuresContract.hasRole(futuresSettlementRole, deployment.addresses.settlementManager))) {
    const tx = await futuresContract.grantRole(
      futuresSettlementRole,
      deployment.addresses.settlementManager,
    );
    await tx.wait();
  }

  if (!(await futuresContract.hasRole(futuresMarketManagerRole, deployment.addresses.settlementManager))) {
    const tx = await futuresContract.grantRole(
      futuresMarketManagerRole,
      deployment.addresses.settlementManager,
    );
    await tx.wait();
  }

  if (!(await futuresOrderBook.hasRole(orderBookSettlementRole, deployment.addresses.settlementManager))) {
    const tx = await futuresOrderBook.grantRole(
      orderBookSettlementRole,
      deployment.addresses.settlementManager,
    );
    await tx.wait();
  }

  if ((await settlementManager.orderBook()) !== deployment.addresses.futuresOrderBook) {
    const tx = await settlementManager.setOrderBook(deployment.addresses.futuresOrderBook);
    await tx.wait();
  }

  return {
    roles: {
      futuresSettlement: {
        vaultSettlementRole: true,
        futuresContractSettlementManagerRole: true,
        futuresContractMarketManagerRole: true,
        futuresOrderBookSettlementManagerRole: true,
        orderBookLinked: true,
      },
    },
  };
}
