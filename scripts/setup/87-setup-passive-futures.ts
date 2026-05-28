async function grantIfMissing(contract: any, role: string, target: string) {
  if (!(await contract.hasRole(role, target))) {
    const tx = await contract.grantRole(role, target);
    await tx.wait();
  }
}

export async function setupPassiveFutures(
  ethers: any,
  deployment: {
    addresses: {
      accountRegistry: string;
      futuresOrderBook: string;
      passiveFuturesSnapshotPublisher: string;
      passiveFuturesPoolFactory: string;
    };
  },
) {
  const accountRegistry = await ethers.getContractAt(
    "AccountRegistry",
    deployment.addresses.accountRegistry,
  );

  const futuresOrderBook = await ethers.getContractAt(
    "FuturesOrderBook",
    deployment.addresses.futuresOrderBook,
  );

  const FACTORY_ROLE = await accountRegistry.FACTORY_ROLE();
  await grantIfMissing(
    accountRegistry,
    FACTORY_ROLE,
    deployment.addresses.passiveFuturesPoolFactory,
  );

  const ADMIN_ROLE = await futuresOrderBook.ADMIN_ROLE();

  await grantIfMissing(
    futuresOrderBook,
    ADMIN_ROLE,
    deployment.addresses.passiveFuturesPoolFactory,
  );

  const PASSIVE_MM_PUBLISHER_ROLE =
    await futuresOrderBook.PASSIVE_MM_PUBLISHER_ROLE();

  if (
    !(await futuresOrderBook.hasRole(
      PASSIVE_MM_PUBLISHER_ROLE,
      deployment.addresses.passiveFuturesSnapshotPublisher,
    ))
  ) {
    const tx = await futuresOrderBook.setPassivePublisher(
      deployment.addresses.passiveFuturesSnapshotPublisher,
      true,
    );
    await tx.wait();
  }

  return {
    passiveFutures: {
      passiveFuturesPoolFactoryHasRegistryFactoryRole:
        await accountRegistry.hasRole(
          FACTORY_ROLE,
          deployment.addresses.passiveFuturesPoolFactory,
        ),
      passiveFuturesPoolFactoryHasOrderBookAdminRole:
        await futuresOrderBook.hasRole(
          ADMIN_ROLE,
          deployment.addresses.passiveFuturesPoolFactory,
        ),
      passiveFuturesSnapshotPublisherHasPublisherRole:
        await futuresOrderBook.hasRole(
          PASSIVE_MM_PUBLISHER_ROLE,
          deployment.addresses.passiveFuturesSnapshotPublisher,
        ),
    },
  };
}
