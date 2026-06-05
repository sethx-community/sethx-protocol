export async function setupFutures(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      priceManager: string;
      futuresContract: string;
      futuresPositionStore: string;
      futuresOrderBook: string;
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

  const futuresPositionStore = await ethers.getContractAt(
    "FuturesPositionStore",
    deployment.addresses.futuresPositionStore,
  );

  const futuresOrderBook = await ethers.getContractAt(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
  );

  if (
    (await futuresContract.priceManager()) !== deployment.addresses.priceManager
  ) {
    const tx = await futuresContract.setPriceManager(
      deployment.addresses.priceManager,
    );
    await tx.wait();
  }

  if (
    (await futuresContract.positionStore()) !==
    deployment.addresses.futuresPositionStore
  ) {
    const tx = await futuresContract.setPositionStore(
      deployment.addresses.futuresPositionStore,
    );
    await tx.wait();
  }

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const vaultSettlementRole = await vault.SETTLEMENT_ROLE();
  const futuresOrderbookRole = await futuresContract.ORDERBOOK_ROLE();
  const futuresEngineRole = await futuresPositionStore.FUTURES_ENGINE_ROLE();

  // FuturesOrderBook needs vault ORDERBOOK_ROLE:
  // lockETH, unlockETH, transferETH/transferToken, chargeFee.
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

  // FuturesContract needs vault SETTLEMENT_ROLE:
  // collectToSettlement, payFromFuturesSettlementLocked,
  // liquidation rewards / settlement-pool accounting.
  if (
    !(await vault.hasRole(
      vaultSettlementRole,
      deployment.addresses.futuresContract,
    ))
  ) {
    const tx = await vault.grantRole(
      vaultSettlementRole,
      deployment.addresses.futuresContract,
    );
    await tx.wait();
  }

  // Optional but safe:
  // FuturesContract also calls vault.lockETH/unlockETH/transferETH in user-facing
  // margin and liquidation flows. SETTLEMENT_ROLE already permits these through
  // onlyOrderbookOrSettlement, but keeping ORDERBOOK_ROLE is not harmful.
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

  // FuturesOrderBook is allowed to mutate futures positions.
  if (
    !(await futuresContract.hasRole(
      futuresOrderbookRole,
      deployment.addresses.futuresOrderBook,
    ))
  ) {
    const tx = await futuresContract.grantRole(
      futuresOrderbookRole,
      deployment.addresses.futuresOrderBook,
    );
    await tx.wait();
  }

  // FuturesContract is the only engine allowed to mutate FuturesPositionStore.
  if (
    !(await futuresPositionStore.hasRole(
      futuresEngineRole,
      deployment.addresses.futuresContract,
    ))
  ) {
    const tx = await futuresPositionStore.grantRole(
      futuresEngineRole,
      deployment.addresses.futuresContract,
    );
    await tx.wait();
  }

  return {
    roles: {
      futuresContract: {
        priceManager: true,
        positionStore: true,
        vaultSettlementRole: true,
        vaultOrderbookRole: true,
      },
      futuresPositionStore: {
        futuresContractEngineRole: true,
      },
      futuresOrderBook: {
        vaultOrderbookRole: true,
        futuresContractOrderbookRole: true,
      },
    },
  };
}
