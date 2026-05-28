// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { TreasuryModuleBase } from "./TreasuryModuleBase.sol";

interface IFuturesPassiveSnapshotOrderBook {
    function publishPassiveSnapshot(
        bytes32 marketKey,
        uint128 bidPrice,
        uint128 bidSize,
        uint128 askPrice,
        uint128 askSize,
        uint64 validForBlocks
    ) external;
}

/**
 * @title PassiveFuturesSnapshotPublisher
 * @notice Manual treasury-authorized publisher for passive futures orderbook snapshots.
 *
 * Design:
 * - This contract is granted PASSIVE_MM_PUBLISHER_ROLE on FuturesOrderBook.
 * - TreasuryAuthority appoints liquidity treasurers.
 * - A liquidity treasurer manually chooses snapshot parameters and publishes.
 * - FuturesOrderBook performs market, pool, quote, crossing, and capacity validation.
 */
contract PassiveFuturesSnapshotPublisher is TreasuryModuleBase {
    IFuturesPassiveSnapshotOrderBook public futuresOrderBook;

    event FuturesOrderBookSet(address indexed oldOrderBook, address indexed newOrderBook);

    event PassiveSnapshotPublishedByTreasurer(
        address indexed treasurer,
        address indexed futuresOrderBook,
        bytes32 indexed marketKey,
        uint128 bidPrice,
        uint128 bidSize,
        uint128 askPrice,
        uint128 askSize,
        uint64 validForBlocks,
        string memo
    );

    error EmptyMemo();

    constructor(address authority_, address futuresOrderBook_) TreasuryModuleBase(authority_) {
        if (futuresOrderBook_ == address(0)) revert InvalidAddress();

        futuresOrderBook = IFuturesPassiveSnapshotOrderBook(futuresOrderBook_);
    }

    function setFuturesOrderBook(address newFuturesOrderBook) external onlyGovernor {
        if (newFuturesOrderBook == address(0)) revert InvalidAddress();

        address old = address(futuresOrderBook);
        futuresOrderBook = IFuturesPassiveSnapshotOrderBook(newFuturesOrderBook);

        emit FuturesOrderBookSet(old, newFuturesOrderBook);
    }

    function publishPassiveSnapshot(
        bytes32 marketKey,
        uint128 bidPrice,
        uint128 bidSize,
        uint128 askPrice,
        uint128 askSize,
        uint64 validForBlocks,
        string calldata memo
    ) external onlyLiquidityTreasurer {
        if (bytes(memo).length == 0) revert EmptyMemo();

        futuresOrderBook.publishPassiveSnapshot(
            marketKey,
            bidPrice,
            bidSize,
            askPrice,
            askSize,
            validForBlocks
        );

        emit PassiveSnapshotPublishedByTreasurer(
            msg.sender,
            address(futuresOrderBook),
            marketKey,
            bidPrice,
            bidSize,
            askPrice,
            askSize,
            validForBlocks,
            memo
        );
    }
}
