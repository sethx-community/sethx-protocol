export async function setupTokenSpotOrderBook(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      tokenSpotOrderBook: string;
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
    deployment.addresses.tokenSpotOrderBook,
  );

  if (!hasRole) {
    const grantTx = await vault.grantRole(
      orderbookRole,
      deployment.addresses.tokenSpotOrderBook,
    );

    await grantTx.wait();
  }

  return {
    roles: {
      tokenSpotOrderBook: {
        vaultOrderbookRole: true,
      },
    },
  };
}
