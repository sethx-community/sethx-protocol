// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { TreasuryModuleBase } from "./TreasuryModuleBase.sol";
import { ProtocolTreasury } from "./ProtocolTreasury.sol";
import { FuturesTypes } from "../markets/futures/FuturesTypes.sol";

interface IFuturesMaintenance {
    function syncSettlementPrice(bytes32 marketKey) external returns (uint256 newPriceRaw);

    function rebaseLosingPositionsToBufferTarget(
        bytes32 marketKey,
        FuturesTypes.PositionSide losingSide,
        uint256 targetSettlementBuffer,
        uint256 maxSteps
    )
        external
        returns (
            uint256 scanned,
            uint256 rebased,
            uint256 amountCollected,
            uint256 settlementBufferAfter
        );
}

contract TreasuryFuturesMaintenanceModule is TreasuryModuleBase {
    ProtocolTreasury public immutable protocolTreasury;
    IFuturesMaintenance public futuresContract;

    uint256 public maxGasReimbursement = 0.01 ether;
    uint256 public gasReimbursementOverhead = 50_000;

    event FuturesContractSet(
        address indexed oldFuturesContract,
        address indexed newFuturesContract
    );
    event MaxGasReimbursementUpdated(uint256 oldValue, uint256 newValue);
    event GasReimbursementOverheadUpdated(uint256 oldValue, uint256 newValue);

    event FuturesSettlementPriceSyncedByTreasurer(
        address indexed treasurer,
        bytes32 indexed marketKey,
        uint256 newPriceRaw,
        uint256 reimbursement,
        string memo
    );

    event FuturesLosingPositionsRebasedByTreasurer(
        address indexed treasurer,
        bytes32 indexed marketKey,
        FuturesTypes.PositionSide indexed losingSide,
        uint256 scanned,
        uint256 rebased,
        uint256 amountCollected,
        uint256 settlementBufferAfter,
        uint256 reimbursement,
        string memo
    );

    error EmptyMemo();
    error InvalidAmount();

    constructor(
        address authority_,
        address protocolTreasury_,
        address futuresContract_
    ) TreasuryModuleBase(authority_) {
        if (protocolTreasury_ == address(0)) revert InvalidAddress();
        if (futuresContract_ == address(0)) revert InvalidAddress();

        protocolTreasury = ProtocolTreasury(payable(protocolTreasury_));
        futuresContract = IFuturesMaintenance(futuresContract_);
    }

    function setFuturesContract(address newFuturesContract) external onlyGovernor {
        if (newFuturesContract == address(0)) revert InvalidAddress();

        address old = address(futuresContract);
        futuresContract = IFuturesMaintenance(newFuturesContract);

        emit FuturesContractSet(old, newFuturesContract);
    }

    function setMaxGasReimbursement(uint256 newValue) external onlyGovernor {
        if (newValue > 0.05 ether) revert InvalidAmount();

        uint256 old = maxGasReimbursement;
        maxGasReimbursement = newValue;

        emit MaxGasReimbursementUpdated(old, newValue);
    }

    function setGasReimbursementOverhead(uint256 newValue) external onlyGovernor {
        if (newValue > 250_000) revert InvalidAmount();

        uint256 old = gasReimbursementOverhead;
        gasReimbursementOverhead = newValue;

        emit GasReimbursementOverheadUpdated(old, newValue);
    }

    function syncFuturesSettlementPrice(
        bytes32 marketKey,
        string calldata memo
    ) external onlyLiquidityTreasurer returns (uint256 newPriceRaw, uint256 reimbursement) {
        if (bytes(memo).length == 0) revert EmptyMemo();

        uint256 gasStart = gasleft();

        newPriceRaw = futuresContract.syncSettlementPrice(marketKey);

        reimbursement = _reimburseGas(gasStart, payable(msg.sender));

        emit FuturesSettlementPriceSyncedByTreasurer(
            msg.sender,
            marketKey,
            newPriceRaw,
            reimbursement,
            memo
        );
    }

    function rebaseFuturesLosingPositionsToBufferTarget(
        bytes32 marketKey,
        FuturesTypes.PositionSide losingSide,
        uint256 targetSettlementBuffer,
        uint256 maxSteps,
        string calldata memo
    )
        external
        onlyLiquidityTreasurer
        returns (
            uint256 scanned,
            uint256 rebased,
            uint256 amountCollected,
            uint256 settlementBufferAfter,
            uint256 reimbursement
        )
    {
        if (bytes(memo).length == 0) revert EmptyMemo();

        uint256 gasStart = gasleft();

        (scanned, rebased, amountCollected, settlementBufferAfter) = futuresContract
            .rebaseLosingPositionsToBufferTarget(
                marketKey,
                losingSide,
                targetSettlementBuffer,
                maxSteps
            );

        reimbursement = _reimburseGas(gasStart, payable(msg.sender));

        emit FuturesLosingPositionsRebasedByTreasurer(
            msg.sender,
            marketKey,
            losingSide,
            scanned,
            rebased,
            amountCollected,
            settlementBufferAfter,
            reimbursement,
            memo
        );
    }

    function _reimburseGas(
        uint256 gasStart,
        address payable recipient
    ) internal returns (uint256 reimbursement) {
        uint256 gasUsed = gasStart - gasleft() + gasReimbursementOverhead;
        reimbursement = gasUsed * tx.gasprice;

        if (reimbursement > maxGasReimbursement) {
            reimbursement = maxGasReimbursement;
        }

        if (reimbursement == 0) {
            return 0;
        }

        protocolTreasury.payETH(recipient, reimbursement);
    }
}
