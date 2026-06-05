async function grantRoleIfMissing(
  contract: any,
  role: string,
  account: string,
) {
  if (await contract.hasRole(role, account)) return false;

  const tx = await contract.grantRole(role, account);
  await tx.wait();
  return true;
}

export async function setupGovernance(
  ethers: any,
  deployment: {
    addresses: {
      sethxTimelock: string;
      sethxGovernor: string;
    };
  },
) {
  const sethxTimelock = await ethers.getContractAt(
    "SethxTimelock",
    deployment.addresses.sethxTimelock,
  );

  const proposerRole = await sethxTimelock.PROPOSER_ROLE();
  const executorRole = await sethxTimelock.EXECUTOR_ROLE();
  const cancellerRole = await sethxTimelock.CANCELLER_ROLE();
  const defaultAdminRole = await sethxTimelock.DEFAULT_ADMIN_ROLE();

  const openExecutor = ethers.ZeroAddress;

  await grantRoleIfMissing(
    sethxTimelock,
    proposerRole,
    deployment.addresses.sethxGovernor,
  );

  await grantRoleIfMissing(
    sethxTimelock,
    cancellerRole,
    deployment.addresses.sethxGovernor,
  );

  await grantRoleIfMissing(sethxTimelock, executorRole, openExecutor);

  return {
    roles: {
      timelock: {
        defaultAdminRole,
        proposerRole,
        executorRole,
        cancellerRole,
        governor: deployment.addresses.sethxGovernor,
        openExecutor,
        deployerAdminRevoked: false,
        deployerAdminRevocationStage: "99-final-governance-handoff",
      },
    },
  };
}
