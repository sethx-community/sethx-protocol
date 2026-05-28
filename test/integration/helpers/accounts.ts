export async function createNormalAccount(
  ethers: any,
  accountFactory: any,
  accountRegistry: any,
  owner: any,
) {
  const ownerAddress = await owner.getAddress();

  const beforeCount = await accountRegistry.normalAccountCount(ownerAddress);

  const tx = await accountFactory.connect(owner).createAccount();
  await tx.wait();

  const afterCount = await accountRegistry.normalAccountCount(ownerAddress);

  if (afterCount !== beforeCount + 1n) {
    throw new Error("Normal account count did not increase");
  }

  const accountAddress =
    await accountRegistry.latestNormalAccount(ownerAddress);

  if ((await accountRegistry.isAccount(accountAddress)) !== true) {
    throw new Error("Created normal account is not active in AccountRegistry");
  }

  if ((await accountRegistry.isRegisteredAccount(accountAddress)) !== true) {
    throw new Error(
      "Created normal account is not registered in AccountRegistry",
    );
  }

  if ((await accountRegistry.isLendingAccount(accountAddress)) !== false) {
    throw new Error("Created normal account is incorrectly marked as lending");
  }

  const registeredOwner = await accountRegistry.ownerOfAccount(accountAddress);

  if (ethers.getAddress(registeredOwner) !== ethers.getAddress(ownerAddress)) {
    throw new Error("Created normal account owner mismatch");
  }

  return ethers.getContractAt("Account", accountAddress);
}

export async function createLendingAccount(
  ethers: any,
  lendingAccountFactory: any,
  accountRegistry: any,
  owner: any,
) {
  const ownerAddress = await owner.getAddress();

  const beforeCount = await accountRegistry.lendingAccountCount(ownerAddress);

  const tx = await lendingAccountFactory.connect(owner).createLendingAccount();
  await tx.wait();

  const afterCount = await accountRegistry.lendingAccountCount(ownerAddress);

  if (afterCount !== beforeCount + 1n) {
    throw new Error("Lending account count did not increase");
  }

  const accountAddress =
    await accountRegistry.latestLendingAccount(ownerAddress);

  if ((await accountRegistry.isAccount(accountAddress)) !== false) {
    throw new Error("Created lending account is incorrectly marked as normal");
  }

  if ((await accountRegistry.isLendingAccount(accountAddress)) !== true) {
    throw new Error("Created lending account is not active in AccountRegistry");
  }

  if (
    (await accountRegistry.isRegisteredLendingAccount(accountAddress)) !== true
  ) {
    throw new Error(
      "Created lending account is not registered in AccountRegistry",
    );
  }

  const registeredOwner = await accountRegistry.ownerOfAccount(accountAddress);

  if (ethers.getAddress(registeredOwner) !== ethers.getAddress(ownerAddress)) {
    throw new Error("Created lending account owner mismatch");
  }

  return ethers.getContractAt("LendingAccount", accountAddress);
}
