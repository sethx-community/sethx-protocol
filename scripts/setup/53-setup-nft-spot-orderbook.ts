export async function setupNftSpotOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      nftSpotOrderBook: string;
    };
  },
) {
  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const orderbookRole = await vault.ORDERBOOK_ROLE();

  const hasRole = await vault.hasRole(
    orderbookRole,
    deployment.addresses.nftSpotOrderBook,
  );

  if (!hasRole) {
    const grantTx = await vault.grantRole(
      orderbookRole,
      deployment.addresses.nftSpotOrderBook,
    );

    await grantTx.wait();
  }

  return {
    roles: {
      nftSpotOrderBook: {
        vaultOrderbookRole: true,
      },
    },
  };
}
