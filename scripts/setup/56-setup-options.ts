export async function setupOptions(
  ethers: any,
  deployment: {
    addresses: {
      sethxVault: string;
      optionContract: string;
      optionsOrderBook: string;
    };
  },
  parameters: {
    options?: {
      defaultExerciseWindowSeconds?: number | bigint;
    };
  } = {},
) {
  const vault = await ethers.getContractAt(
    "SethxVault",
    deployment.addresses.sethxVault,
  );

  const optionContract = await ethers.getContractAt(
    "OptionContract",
    deployment.addresses.optionContract,
  );

  const vaultOrderbookRole = await vault.ORDERBOOK_ROLE();
  const optionOrderbookRole = await optionContract.ORDERBOOK_ROLE();

  const optionContractHasVaultRole = await vault.hasRole(
    vaultOrderbookRole,
    deployment.addresses.optionContract,
  );

  if (!optionContractHasVaultRole) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.optionContract,
    );
    await tx.wait();
  }

  const optionsOrderBookHasVaultRole = await vault.hasRole(
    vaultOrderbookRole,
    deployment.addresses.optionsOrderBook,
  );

  if (!optionsOrderBookHasVaultRole) {
    const tx = await vault.grantRole(
      vaultOrderbookRole,
      deployment.addresses.optionsOrderBook,
    );
    await tx.wait();
  }

  const optionsOrderBookHasOptionRole = await optionContract.hasRole(
    optionOrderbookRole,
    deployment.addresses.optionsOrderBook,
  );

  if (!optionsOrderBookHasOptionRole) {
    const tx = await optionContract.grantRole(
      optionOrderbookRole,
      deployment.addresses.optionsOrderBook,
    );
    await tx.wait();
  }


  const defaultExerciseWindowSeconds =
    parameters.options?.defaultExerciseWindowSeconds;
  if (defaultExerciseWindowSeconds !== undefined) {
    const desiredWindow = BigInt(defaultExerciseWindowSeconds);
    const currentWindow = await optionContract.defaultExerciseWindow();
    if (currentWindow !== desiredWindow) {
      const tx = await optionContract.setDefaultExerciseWindow(desiredWindow);
      await tx.wait();
    }
  }

  return {
    roles: {
      optionContract: {
        vaultOrderbookRole: true,
      },
      optionsOrderBook: {
        vaultOrderbookRole: true,
        optionContractOrderbookRole: true,
      },
    },
  };
}
