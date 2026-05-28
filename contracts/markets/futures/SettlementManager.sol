// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { FuturesContract } from "./FuturesContract.sol";
import { FuturesOrderBook } from "./FuturesOrderBook.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { PriceManager } from "../../oracle/PriceManager.sol";

/// @notice SettlementManager (batched + "smart" liquidation optimization):
/// - Trades do NOT require settlement.
/// - Settlement realizes PnL vs FuturesContract.lastSettlementPrice (index) when run.
/// - Loss collection is capped by vault locked funds.
/// - Profit payout is bounded by what was collected + buffers used.
/// - Optimization: if FuturesContract.canSkipLiquidationScan(marketKey, markRaw) == true,
///   we DO NOT attempt liquidations during loser processing.
/// - Supports settleAll() to do everything in one call.
///
/// IMPORTANT CORRECTNESS NOTE FOR BATCHING:
/// - FuturesContract.getLongHolders()/getShortHolders() returns a dynamic set.
/// - Liquidations can REMOVE users from those sets, which would break index-based batching.
/// - Therefore we SNAPSHOT losers + winners at startSettlement into storage arrays used for the round.
contract SettlementManager is AccessControl {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    // -------- Errors --------
    error ZeroAddress();
    error UnknownMarket();
    error InvalidPrice();
    error RoundActive();
    error WrongPhase();
    error InvalidSteps();
    error MissingLastPrice();

    FuturesContract public immutable futures;
    SethxVault public immutable vault;
    FuturesOrderBook public orderBook;

    enum Phase {
        NONE,
        COLLECT_LOSERS,
        PAY_WINNERS,
        FINALIZE
    }

    struct Round {
        Phase phase;
        // Raw oracle prices (oracle decimals)
        uint256 lastSettlementRaw;
        uint256 newSettlementRaw;
        // Normalized prices using ETH margin decimals
        uint256 lastSettlementNorm;
        uint256 newSettlementNorm;
        uint256 deltaNorm;
        bool longsAreWinning;
        bool skipLiquidationScan;
        uint8 marginDec;
        uint256 multiplier;
        // Totals
        uint256 totalNotionalLoss;
        uint256 totalCollectibleLoss;
        uint256 totalWinningSize;
        uint256 profitOwed;
        uint256 effectiveProfitPaid;
        uint256 underfundDeficit;
        uint256 imbalanceDeficit;
        uint256 usedLiquidationBuffer;
        uint256 usedImbalanceBuffer;
        uint256 loserIndex;
        uint256 winnerIndex;
        // Snapshot lengths (for cheap checks)
        uint256 losersLen;
        uint256 winnersLen;
    }

    mapping(bytes32 => Round) public rounds;

    // Snapshots per market per active round
    mapping(bytes32 => address[]) private _roundLosers;
    mapping(bytes32 => address[]) private _roundWinners;

    event RoundStarted(
        bytes32 indexed marketKey,
        uint256 lastSettlementRaw,
        uint256 newSettlementRaw,
        bool longsAreWinning,
        uint256 deltaNorm,
        bool skipLiquidationScan
    );

    event LosersStep(
        bytes32 indexed marketKey,
        uint256 processed,
        uint256 nextIndex,
        uint256 totalNotionalLoss,
        uint256 totalCollectibleLoss
    );

    event WinnersStep(
        bytes32 indexed marketKey,
        uint256 processed,
        uint256 nextIndex,
        uint256 effectiveProfitPaid
    );

    event RoundFinalized(
        bytes32 indexed marketKey,
        uint256 lastSettlementRaw,
        uint256 newSettlementRaw,
        bool longsAreWinning,
        uint256 deltaNorm,
        uint256 totalNotionalLoss,
        uint256 totalCollectibleLoss,
        uint256 profitOwed,
        uint256 effectiveProfitPaid,
        uint256 underfundDeficit,
        uint256 imbalanceDeficit,
        uint256 usedLiquidationBuffer,
        uint256 usedImbalanceBuffer,
        uint256 remainingUnderfundDeficit,
        uint256 remainingImbalanceDeficit
    );

    event SyntheticImbalanceReplaced(
        bytes32 indexed marketKey,
        bool active,
        FuturesOrderBook.Side makerSide,
        uint256 amount,
        uint256 execPrice
    );

    event LiquidationSeized(
        bytes32 indexed marketKey,
        address indexed user,
        bool isLong,
        uint256 size,
        uint256 seizedMargin,
        uint256 markRaw
    );

    constructor(address _futures, address _vault, address admin) {
        if (_futures == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        futures = FuturesContract(_futures);
        vault = SethxVault(_vault);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTLER_ROLE, admin);
    }

    function setOrderBook(address _orderBook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_orderBook == address(0)) revert ZeroAddress();
        orderBook = FuturesOrderBook(_orderBook);
    }

    // =========================================================
    // Required 4-phase functions
    // =========================================================

    /// @notice Begin a settlement round for a market at newSettlementRaw (raw oracle price).
    function _startSettlement(bytes32 marketKey, uint256 newSettlementRaw) internal {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);
        if (m.oracle == address(0)) revert UnknownMarket();
        if (newSettlementRaw == 0) revert InvalidPrice();

        Round storage r = rounds[marketKey];
        if (r.phase != Phase.NONE) revert RoundActive();

        uint256 lastRaw = m.lastSettlementPrice;
        if (lastRaw == 0) revert MissingLastPrice();

        uint256 lastNorm = futures.normalizePrice(marketKey, lastRaw);
        uint256 newNorm = futures.normalizePrice(marketKey, newSettlementRaw);

        bool longsWin = newNorm > lastNorm;
        uint256 delta = newNorm > lastNorm ? (newNorm - lastNorm) : (lastNorm - newNorm);

        // Optimization: if mark is inside conservative no-liquidation band, skip liquidation attempts.
        bool skipLiq = futures.canSkipLiquidationScan(marketKey, newSettlementRaw);

        // Snapshot holders ONCE for this round (correct under batching, even if liquidations happen).
        _snapshotRoundHolders(marketKey, longsWin);

        r.phase = Phase.COLLECT_LOSERS;

        r.lastSettlementRaw = lastRaw;
        r.newSettlementRaw = newSettlementRaw;

        r.lastSettlementNorm = lastNorm;
        r.newSettlementNorm = newNorm;
        r.deltaNorm = delta;

        r.longsAreWinning = longsWin;
        r.skipLiquidationScan = skipLiq;

        r.marginDec = m.marginDecimals;
        r.multiplier = m.multiplier;

        // reset totals / cursors
        r.totalNotionalLoss = 0;
        r.totalCollectibleLoss = 0;
        r.totalWinningSize = 0;
        r.profitOwed = 0;
        r.effectiveProfitPaid = 0;
        r.underfundDeficit = 0;
        r.imbalanceDeficit = 0;
        r.usedLiquidationBuffer = 0;
        r.usedImbalanceBuffer = 0;
        r.loserIndex = 0;
        r.winnerIndex = 0;

        r.losersLen = _roundLosers[marketKey].length;
        r.winnersLen = _roundWinners[marketKey].length;

        emit RoundStarted(marketKey, lastRaw, newSettlementRaw, longsWin, delta, skipLiq);

        // If no move: update index + synthetic and end immediately.
        if (delta == 0) {
            futures.setLastSettlementPrice(marketKey, newSettlementRaw);
            _closeMarketIfOracleUnusable(marketKey);
            _replaceSyntheticImbalance(marketKey, newSettlementRaw);

            emit RoundFinalized(
                marketKey,
                lastRaw,
                newSettlementRaw,
                false,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0
            );

            _clearRound(marketKey);
        }
    }

    /// @notice Batched: collect losses from losing side into vault settlement pool.
    /// Also optionally liquidates during the loop, unless skipLiquidationScan is true.
    function stepCollectLoserLosses(
        bytes32 marketKey,
        uint256 maxSteps
    ) public onlyRole(SETTLER_ROLE) {
        Round storage r = rounds[marketKey];
        if (r.phase != Phase.COLLECT_LOSERS) revert WrongPhase();
        if (maxSteps == 0) revert InvalidSteps();

        if (r.deltaNorm == 0) {
            r.phase = Phase.FINALIZE;
            return;
        }

        bool losingIsLong = !r.longsAreWinning;

        address[] storage losers = _roundLosers[marketKey];
        uint256 processed = 0;

        while (r.loserIndex < losers.length && processed < maxSteps) {
            address user = losers[r.loserIndex];
            r.loserIndex++;
            processed++;

            FuturesContract.Position memory pos = futures.getPosition(
                user,
                marketKey,
                losingIsLong
            );
            if (!pos.isActive || pos.size == 0) continue;

            // theoretical loss in quote units:
            uint256 theoLoss =
                (pos.size * r.multiplier * r.deltaNorm) / (10 ** uint256(r.marginDec));
            if (theoLoss == 0) continue;

            r.totalNotionalLoss += theoLoss;

            // Optional liquidation attempt during loser loop (skip when safely inside band)
            if (!r.skipLiquidationScan) {
                try
                    futures.liquidatePosition(marketKey, user, losingIsLong, r.newSettlementRaw)
                returns (uint256 seizedMargin, uint256 liqSize) {
                    if (seizedMargin > 0) {
                        // Cap custody collect by *current* remaining locked (loss collection may have reduced it)
                        uint256 lockedAfter = _getLockedETH(user);
                        uint256 seizeCollect =
                            lockedAfter >= seizedMargin ? seizedMargin : lockedAfter;

                        if (seizeCollect > 0) {
                            vault.collectToSettlement(
                                marketKey,
                                user,
                                address(0),
                                seizeCollect,
                                "Futures liquidation seized margin"
                            );
                        }
                    }

                    emit LiquidationSeized(
                        marketKey,
                        user,
                        losingIsLong,
                        liqSize,
                        seizedMargin,
                        r.newSettlementRaw
                    );
                } catch {
                    // ignore (not liquidatable or other revert)
                }
            }
            FuturesContract.Position memory afterLiq = futures.getPosition(
                user,
                marketKey,
                losingIsLong
            );

            if (!afterLiq.isActive || afterLiq.size == 0) {
                continue;
            }

            uint256 lockedAvail = _getLockedETH(user);
            uint256 collectible = lockedAvail >= theoLoss ? theoLoss : lockedAvail;

            if (collectible > 0) {
                // Ledger debit capped to what we actually collect in custody.
                futures.settlePositionCapped(
                    marketKey,
                    user,
                    losingIsLong,
                    r.newSettlementRaw,
                    collectible
                );

                vault.collectToSettlement(
                    marketKey,
                    user,
                    address(0),
                    collectible,
                    "Futures settlement loss"
                );

                r.totalCollectibleLoss += collectible;
            } else {
                // No custody collectible; we deliberately do NOT force a ledger debit here,
                // because that would create an unbacked negative margin. Deficit is handled
                // via underfundDeficit / buffers and reduced winner payout.
            }
        }

        emit LosersStep(
            marketKey,
            processed,
            r.loserIndex,
            r.totalNotionalLoss,
            r.totalCollectibleLoss
        );

        // If finished losers, compute payouts + buffers and move to PAY_WINNERS
        if (r.loserIndex >= losers.length) {
            _enterPayWinnersPhase(marketKey, r);
        }
    }

    /// @notice Batched: pay winners pro-rata from settlement pool (bounded by effectiveProfitPaid).
    function stepPayWinnerProfits(
        bytes32 marketKey,
        uint256 maxSteps
    ) public onlyRole(SETTLER_ROLE) {
        Round storage r = rounds[marketKey];
        if (r.phase != Phase.PAY_WINNERS) revert WrongPhase();
        if (maxSteps == 0) revert InvalidSteps();

        if (r.effectiveProfitPaid == 0 || r.totalWinningSize == 0) {
            r.phase = Phase.FINALIZE;
            return;
        }

        address[] storage winners = _roundWinners[marketKey];
        uint256 processed = 0;

        while (r.winnerIndex < winners.length && processed < maxSteps) {
            address user = winners[r.winnerIndex];
            r.winnerIndex++;
            processed++;

            FuturesContract.Position memory pos = futures.getPosition(
                user,
                marketKey,
                r.longsAreWinning
            );
            if (!pos.isActive || pos.size == 0) continue;

            uint256 share = (pos.size * r.effectiveProfitPaid) / r.totalWinningSize;
            if (share == 0) continue;

            // Ledger credit
            futures.settlePositionCredit(marketKey, user, r.longsAreWinning, share);

            // Custody credit from settlement pool
            vault.payFromFuturesSettlementLocked(
                marketKey,
                user,
                share,
                "Futures settlement profit"
            );
        }

        emit WinnersStep(marketKey, processed, r.winnerIndex, r.effectiveProfitPaid);

        if (r.winnerIndex >= winners.length) {
            r.phase = Phase.FINALIZE;
        }
    }

    /// @notice Finalize: update market index (lastSettlementPrice) and update synthetic imbalance order.
    function finalizeSettlement(bytes32 marketKey) public onlyRole(SETTLER_ROLE) {
        Round storage r = rounds[marketKey];
        if (r.phase != Phase.FINALIZE) revert WrongPhase();

        futures.setLastSettlementPrice(marketKey, r.newSettlementRaw);
        _closeMarketIfOracleUnusable(marketKey);
        _replaceSyntheticImbalance(marketKey, r.newSettlementRaw);

        uint256 remainingUnderfund =
            r.underfundDeficit > r.usedLiquidationBuffer
                ? (r.underfundDeficit - r.usedLiquidationBuffer)
                : 0;

        uint256 remainingImbalance =
            r.imbalanceDeficit > r.usedImbalanceBuffer
                ? (r.imbalanceDeficit - r.usedImbalanceBuffer)
                : 0;

        emit RoundFinalized(
            marketKey,
            r.lastSettlementRaw,
            r.newSettlementRaw,
            r.longsAreWinning,
            r.deltaNorm,
            r.totalNotionalLoss,
            r.totalCollectibleLoss,
            r.profitOwed,
            r.effectiveProfitPaid,
            r.underfundDeficit,
            r.imbalanceDeficit,
            r.usedLiquidationBuffer,
            r.usedImbalanceBuffer,
            remainingUnderfund,
            remainingImbalance
        );

        _clearRound(marketKey);
    }

    // =========================================================
    // Convenience: settle everything in one tx
    // =========================================================

    function settleAll(bytes32 marketKey) external onlyRole(SETTLER_ROLE) {
        uint256 newSettlementRaw = _readOraclePrice(marketKey);

        _startSettlement(marketKey, newSettlementRaw);

        if (rounds[marketKey].phase == Phase.NONE) return;

        while (rounds[marketKey].phase == Phase.COLLECT_LOSERS) {
            stepCollectLoserLosses(marketKey, type(uint256).max);
        }

        while (rounds[marketKey].phase == Phase.PAY_WINNERS) {
            stepPayWinnerProfits(marketKey, type(uint256).max);
        }

        finalizeSettlement(marketKey);
    }

    // =========================================================
    // Internals
    // =========================================================

    function _closeMarketIfOracleUnusable(bytes32 marketKey) internal {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);

        if (
            futures.marketActive(marketKey) &&
            !futures.priceManager().isOracleUsableForFutures(m.oracle)
        ) {
            futures.closeMarket(marketKey);
        }
    }

    function _readOraclePrice(bytes32 marketKey) internal view returns (uint256 price) {
        FuturesContract.MarketConfig memory m = futures.getMarket(marketKey);
        if (m.oracle == address(0)) revert UnknownMarket();

        (price, , , ) = PriceManager(address(futures.priceManager())).getOraclePrice(
            m.oracle,
            PriceManager.OracleContext.FUTURE_SETTLEMENT
        );

        if (price == 0) revert InvalidPrice();
    }

    function _snapshotRoundHolders(bytes32 marketKey, bool longsAreWinning) internal {
        // wipe any stale snapshot first (in case of an unclean previous round)
        delete _roundLosers[marketKey];
        delete _roundWinners[marketKey];

        address[] memory losers =
            longsAreWinning
                ? futures.getShortHolders(marketKey)
                : futures.getLongHolders(marketKey);

        address[] memory winners =
            longsAreWinning
                ? futures.getLongHolders(marketKey)
                : futures.getShortHolders(marketKey);

        // copy into storage
        for (uint256 i = 0; i < losers.length; i++) _roundLosers[marketKey].push(losers[i]);
        for (uint256 i = 0; i < winners.length; i++) _roundWinners[marketKey].push(winners[i]);
    }

    function _enterPayWinnersPhase(bytes32 marketKey, Round storage r) internal {
        r.totalWinningSize =
            r.longsAreWinning ? futures.totalLongs(marketKey) : futures.totalShorts(marketKey);

        r.profitOwed =
            (r.totalWinningSize * r.multiplier * r.deltaNorm) / (10 ** uint256(r.marginDec));

        r.underfundDeficit =
            r.totalNotionalLoss > r.totalCollectibleLoss
                ? (r.totalNotionalLoss - r.totalCollectibleLoss)
                : 0;

        r.imbalanceDeficit =
            r.profitOwed > r.totalNotionalLoss ? (r.profitOwed - r.totalNotionalLoss) : 0;

        if (r.underfundDeficit > 0) {
            r.usedLiquidationBuffer = futures.useLiquidationBuffer(marketKey, r.underfundDeficit);
        }
        if (r.imbalanceDeficit > 0) {
            r.usedImbalanceBuffer = futures.useImbalanceBuffer(marketKey, r.imbalanceDeficit);
        }

        uint256 availableToPay =
            r.totalCollectibleLoss + r.usedLiquidationBuffer + r.usedImbalanceBuffer;
        r.effectiveProfitPaid = availableToPay >= r.profitOwed ? r.profitOwed : availableToPay;

        r.phase = Phase.PAY_WINNERS;
        r.winnerIndex = 0;
    }

    function _getLockedETH(address user) internal view returns (uint256) {
        return vault.getLockedETHBalance(user);
    }

    /// Convention:
    /// - imbalance > 0 (more longs): makerSide=Buy (long maker), so users can sell/short against it
    /// - imbalance < 0 (more shorts): makerSide=Sell (short maker), so users can buy/long against it
    function _replaceSyntheticImbalance(bytes32 marketKey, uint256 settlementRawPrice) internal {
        if (address(orderBook) == address(0)) return;

        int256 imbalance = futures.getOpenInterestImbalance(marketKey);

        if (imbalance == 0) {
            orderBook.replaceSyntheticImbalanceOrder(
                marketKey,
                false,
                FuturesOrderBook.Side.Buy,
                0,
                0
            );
            emit SyntheticImbalanceReplaced(marketKey, false, FuturesOrderBook.Side.Buy, 0, 0);
            return;
        }

        FuturesOrderBook.Side makerSide;
        uint256 amount;

        if (imbalance > 0) {
            makerSide = FuturesOrderBook.Side.Buy;
            amount = uint256(imbalance);
        } else {
            makerSide = FuturesOrderBook.Side.Sell;
            amount = uint256(-imbalance);
        }

        orderBook.replaceSyntheticImbalanceOrder(
            marketKey,
            true,
            makerSide,
            amount,
            settlementRawPrice
        );
        emit SyntheticImbalanceReplaced(marketKey, true, makerSide, amount, settlementRawPrice);
    }

    function _clearRound(bytes32 marketKey) internal {
        delete rounds[marketKey];
        delete _roundLosers[marketKey];
        delete _roundWinners[marketKey];
    }
}
