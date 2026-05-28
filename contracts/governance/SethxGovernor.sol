// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Governor } from "@openzeppelin/contracts/governance/Governor.sol";
import { GovernorSettings } from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import { GovernorCountingSimple } from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import { GovernorVotes } from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import { GovernorTimelockControl } from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

contract SethxGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorTimelockControl
{
    error ZeroAddress();
    error InvalidQuorumBps();
    error InvalidSignalDescription();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_QUORUM_BPS = 5_000;

    address public immutable treasury;

    uint256 private _quorumBps;

    mapping(uint256 proposalId => bool isSignalProposal) public isSignalProposal;

    event QuorumBpsUpdated(uint256 oldQuorumBps, uint256 newQuorumBps);
    event SignalProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        bytes32 indexed descriptionHash,
        string description
    );

    constructor(
        IVotes token,
        TimelockController timelock,
        address treasury_,
        uint48 initialVotingDelay,
        uint32 initialVotingPeriod,
        uint256 initialProposalThreshold,
        uint256 initialQuorumBps
    )
        Governor("SethxGovernor")
        GovernorSettings(initialVotingDelay, initialVotingPeriod, initialProposalThreshold)
        GovernorVotes(token)
        GovernorTimelockControl(timelock)
    {
        if (address(token) == address(0)) revert ZeroAddress();
        if (address(timelock) == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (initialQuorumBps == 0 || initialQuorumBps > MAX_QUORUM_BPS) {
            revert InvalidQuorumBps();
        }

        treasury = treasury_;
        _quorumBps = initialQuorumBps;

        emit QuorumBpsUpdated(0, initialQuorumBps);
    }

    function quorumBps() external view returns (uint256) {
        return _quorumBps;
    }

    function setQuorumBps(uint256 newQuorumBps) external onlyGovernance {
        if (newQuorumBps == 0 || newQuorumBps > MAX_QUORUM_BPS) {
            revert InvalidQuorumBps();
        }

        uint256 oldQuorumBps = _quorumBps;
        _quorumBps = newQuorumBps;

        emit QuorumBpsUpdated(oldQuorumBps, newQuorumBps);
    }

    function quorum(uint256 timepoint) public view override returns (uint256) {
        uint256 totalSupplyAtTimepoint = token().getPastTotalSupply(timepoint);
        uint256 treasuryVotesAtTimepoint = token().getPastVotes(treasury, timepoint);

        uint256 adjustedSupply =
            totalSupplyAtTimepoint > treasuryVotesAtTimepoint
                ? totalSupplyAtTimepoint - treasuryVotesAtTimepoint
                : totalSupplyAtTimepoint;

        return (adjustedSupply * _quorumBps) / BPS_DENOMINATOR;
    }

    function proposeSignal(string calldata description) external returns (uint256 proposalId) {
        bytes32 descriptionHash = keccak256(bytes(description));
        if (descriptionHash == keccak256(bytes(""))) {
            revert InvalidSignalDescription();
        }

        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);

        targets[0] = address(this);
        values[0] = 0;
        calldatas[0] = abi.encodeCall(this.recordSignalProposal, (descriptionHash));

        proposalId = propose(targets, values, calldatas, description);

        isSignalProposal[proposalId] = true;

        emit SignalProposalCreated(proposalId, _msgSender(), descriptionHash, description);
    }

    function recordSignalProposal(bytes32) external onlyGovernance {
        // Intentional no-op.
        //
        // Signaling proposals are used for off-chain/community direction.
        // They should not directly change protocol state other than normal
        // Governor proposal lifecycle state and events.
    }

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function state(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    function supportsInterface(bytes4 interfaceId) public view override(Governor) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
