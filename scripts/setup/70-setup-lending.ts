export async function setupLending(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      lendingContract: string;
      lendingOrderBook: string;
    };
  },
) {
  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const lendingContract = await ethers.getContractAt(
    "LendingContract",
    deployment.addresses.lendingContract,
  );

  const lendingOrderBook = await ethers.getContractAt(
    "LendingOrderBook",
    deployment.addresses.lendingOrderBook,
  );

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const vaultSettlementRole = await vault.SETTLEMENT_ROLE();
  const lendingOrderbookRole = await lendingContract.ORDERBOOK_ROLE();
  const lendingOrderBookGovernorRole = await lendingOrderBook.GOVERNOR_ROLE();

  if (!(await vault.hasRole(vaultOrderbookRole, deployment.addresses.lendingOrderBook))) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.lendingOrderBook,
    );
    await tx.wait();
  }

  if (!(await vault.hasRole(vaultSettlementRole, deployment.addresses.lendingContract))) {
    const tx = await vault.grantRole(
      vaultSettlementRole,
      deployment.addresses.lendingContract,
    );
    await tx.wait();
  }

  if (!(await lendingContract.hasRole(lendingOrderbookRole, deployment.addresses.lendingOrderBook))) {
    const tx = await lendingContract.setOrderBook(
      deployment.addresses.lendingOrderBook,
      true,
    );
    await tx.wait();
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  return {
    roles: {
      lending: {
        vaultOrderbookRole: true,
        vaultSettlementRole: true,
        lendingContractOrderbookRole: true,
        deployerLendingOrderBookGovernorRole: await lendingOrderBook.hasRole(
          lendingOrderBookGovernorRole,
          deployerAddress,
        ),
      },
    },
  };
}
