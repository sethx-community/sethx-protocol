import { safeDeployContract } from "./safe-deploy-contract.js";

export async function deployGovernance(
  ethers: any,
  parameters: {
    governance: {
      timelockDelaySeconds: bigint;
      votingDelayBlocks: bigint;
      votingPeriodBlocks: bigint;
      proposalThreshold: bigint;
      quorumBps: number;
    };
  },
  deployment: {
    addresses: {
      sethxToken: string;
      protocolTreasury: string;
    };
  },
) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const proposalThreshold = parameters.governance.proposalThreshold;
  const quorumBps = BigInt(parameters.governance.quorumBps);

  const sethxTimelock = await safeDeployContract(ethers, "SethxTimelock", [
    parameters.governance.timelockDelaySeconds,
    [],
    [],
    deployerAddress,
  ]);

  const sethxGovernor = await safeDeployContract(ethers, "SethxGovernor", [
    deployment.addresses.sethxToken,
    await sethxTimelock.getAddress(),
    deployment.addresses.protocolTreasury,
    parameters.governance.votingDelayBlocks,
    parameters.governance.votingPeriodBlocks,
    proposalThreshold,
    quorumBps,
  ]);

  return {
    sethxTimelock,
    sethxGovernor,
    addresses: {
      sethxTimelock: await sethxTimelock.getAddress(),
      sethxGovernor: await sethxGovernor.getAddress(),
    },
    governance: {
      timelockDelaySeconds: parameters.governance.timelockDelaySeconds,
      votingDelayBlocks: parameters.governance.votingDelayBlocks,
      votingPeriodBlocks: parameters.governance.votingPeriodBlocks,
      proposalThreshold,
      quorumBps,
    },
  };
}
