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

  await sethxTimelock.grantRole(
    proposerRole,
    deployment.addresses.sethxGovernor,
  );

  await sethxTimelock.grantRole(
    cancellerRole,
    deployment.addresses.sethxGovernor,
  );

  await sethxTimelock.grantRole(executorRole, openExecutor);

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
