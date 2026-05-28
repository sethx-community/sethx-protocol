// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { SethxVault } from "../../vault/SethxVault.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { LendingAccount } from "../../accounts/LendingAccount.sol";

import { LendingContract } from "./LendingContract.sol";
import { LendingOrderBook } from "./LendingOrderBook.sol";
import { ValuationModule } from "./ValuationModule.sol";

interface IAccountOwner {
    function owner() external view returns (address);
}

contract LiquidationEngine is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    string internal constant VAULT_SWEEP_REASON = "liquidation_sweep";
    uint256 public constant BPS = 10_000;

    // -------- Errors --------
    error ZeroAddress();
    error AuctionAlreadyActive();
    error AuctionAlreadyResolved();
    error NoDebtForMarket();
    error AccountNotLiquidatable();
    error NoActiveAuction();
    error AuctionNotActive();
    error AuctionIsExpired();
    error AuctionNotExpired();
    error BuyerNotAccount();
    error InvalidBuyerOwner();
    error RecoveryApplyMismatch();
    error SweepNotApplied();
    error InvalidAuctionDuration();
    error InvalidAuctionCurve();

    struct AuctionConfig {
        uint64 premiumPhaseDuration;
        uint64 parPhaseDuration;
        uint64 discountPhaseDuration;
        uint32 startPriceBps;
        uint32 parPriceBps;
        uint32 endPriceBps;
    }

    struct AuctionState {
        bool active;
        bool sold;
        uint64 startTime;
        uint64 endTime;
        bytes32 marketKey;
        uint16 riskLevel;
        uint256 debtSnapshot;
        uint256 freeEthRecoveredAtTrigger;
        address preLiquidationOwner;
        address winner;
    }

    LendingContract public immutable lendingContract;
    LendingOrderBook public immutable lendingOrderBook;
    AccountRegistry public immutable accountRegistry;
    ValuationModule public immutable valuationModule;
    SethxVault public immutable vault;

    mapping(address => AuctionState) public auctions;
    AuctionConfig public auctionConfig;

    event AuctionConfigSet(
        uint64 premiumPhaseDuration,
        uint64 parPhaseDuration,
        uint64 discountPhaseDuration,
        uint32 startPriceBps,
        uint32 parPriceBps,
        uint32 endPriceBps
    );

    event LiquidationTriggered(
        address indexed account,
        bytes32 indexed marketKey,
        uint16 indexed riskLevel,
        uint256 debtSnapshot,
        uint256 freeEthRecoveredAtTrigger,
        uint256 cancelledOrders,
        address preLiquidationOwner,
        uint64 startTime,
        uint64 endTime
    );

    event AuctionPurchased(
        address indexed account,
        bytes32 indexed marketKey,
        address indexed winner,
        uint256 pricePaid,
        uint256 debtSnapshot,
        uint256 recoveryRouted,
        uint256 borrowerSurplus
    );

    event AuctionCancelled(address indexed account);
    event AuctionExpired(address indexed account, bytes32 indexed marketKey);

    constructor(
        address _vault,
        address _accountRegistry,
        address _lendingContract,
        address _lendingOrderBook,
        address _valuationModule,
        address admin
    ) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (_lendingContract == address(0)) revert ZeroAddress();
        if (_lendingOrderBook == address(0)) revert ZeroAddress();
        if (_valuationModule == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);
        lendingContract = LendingContract(payable(_lendingContract));
        lendingOrderBook = LendingOrderBook(_lendingOrderBook);
        valuationModule = ValuationModule(_valuationModule);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setAuctionConfig(
        uint64 premiumPhaseDuration,
        uint64 parPhaseDuration,
        uint64 discountPhaseDuration,
        uint32 startPriceBps,
        uint32 parPriceBps,
        uint32 endPriceBps
    ) external onlyRole(GOVERNOR_ROLE) {
        _setAuctionConfig(
            premiumPhaseDuration,
            parPhaseDuration,
            discountPhaseDuration,
            startPriceBps,
            parPriceBps,
            endPriceBps
        );
    }

    function triggerLiquidation(address account, bytes32 marketKey, uint16 riskLevel) external {
        if (account == address(0)) revert ZeroAddress();

        AuctionState storage a = auctions[account];
        if (a.active) revert AuctionAlreadyActive();
        if (a.sold) revert AuctionAlreadyResolved();

        uint256 faceValue = lendingContract.getDebt(account, marketKey).faceValue;
        if (faceValue == 0) revert NoDebtForMarket();

        LendingContract.MarketConfig memory market = lendingContract.getMarket(marketKey);
        bool maturedUnpaidDebt = block.timestamp >= market.expiry;
        if (!maturedUnpaidDebt && !valuationModule.isLiquidatable(account, riskLevel)) {
            revert AccountNotLiquidatable();
        }

        address preOwner = LendingAccount(payable(account)).owner();

        LendingAccount(payable(account)).startLiquidation();

        uint256 cancelledOrders = lendingOrderBook.cancelAllOrdersForAccount(account);

        uint256 sweptFreeEth = _sweepFreeEthToDebt(account, marketKey, faceValue);

        uint256 remainingDebt = faceValue > sweptFreeEth ? faceValue - sweptFreeEth : 0;

        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = uint64(
            block.timestamp +
                auctionConfig.premiumPhaseDuration +
                auctionConfig.parPhaseDuration +
                auctionConfig.discountPhaseDuration
        );

        auctions[account] = AuctionState({
            active: true,
            sold: false,
            startTime: startTime,
            endTime: endTime,
            marketKey: marketKey,
            riskLevel: riskLevel,
            debtSnapshot: remainingDebt,
            freeEthRecoveredAtTrigger: sweptFreeEth,
            preLiquidationOwner: preOwner,
            winner: address(0)
        });

        emit LiquidationTriggered(
            account,
            marketKey,
            riskLevel,
            remainingDebt,
            sweptFreeEth,
            cancelledOrders,
            preOwner,
            startTime,
            endTime
        );
    }

    function getCurrentAuctionPrice(address account) public view returns (uint256) {
        AuctionState memory a = auctions[account];
        if (!a.active) revert NoActiveAuction();

        uint256 debt = a.debtSnapshot;
        if (debt == 0) return 0;

        AuctionConfig memory c = auctionConfig;
        uint256 elapsed = block.timestamp > a.startTime ? block.timestamp - a.startTime : 0;

        uint256 premium = c.premiumPhaseDuration;
        uint256 par = c.parPhaseDuration;
        uint256 discount = c.discountPhaseDuration;

        if (elapsed >= premium + par + discount) {
            return (debt * c.endPriceBps) / BPS;
        }

        if (elapsed < premium) {
            return _linearInterpolateBps(debt, c.startPriceBps, c.parPriceBps, elapsed, premium);
        }

        if (elapsed < premium + par) {
            return (debt * c.parPriceBps) / BPS;
        }

        uint256 discountElapsed = elapsed - premium - par;
        return _linearInterpolateBps(debt, c.parPriceBps, c.endPriceBps, discountElapsed, discount);
    }

    function buyAuctionedAccount(address account) external {
        AuctionState storage a = auctions[account];

        if (!a.active) revert AuctionNotActive();
        if (block.timestamp > a.endTime) revert AuctionIsExpired();
        // Auction purchases are account-mediated. Both normal Account and LendingAccount
        // contracts are valid buyers; EOAs and unregistered/fake contracts remain blocked.
        if (!accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)) revert BuyerNotAccount();

        uint256 price = getCurrentAuctionPrice(account);

        // buyer is the registered trading account contract
        address buyerAccount = msg.sender;

        // final owner should be the EOA/user that owns the buyer account
        address newOwner = IAccountOwner(buyerAccount).owner();
        if (newOwner == address(0)) revert InvalidBuyerOwner();

        uint256 debtSnapshot = a.debtSnapshot;
        uint256 currentDebt = lendingContract.getDebt(account, a.marketKey).faceValue;

        uint256 recoveryRouted;
        uint256 borrowerSurplus;

        vault.collectFreeEthToSettlement(
            a.marketKey,
            buyerAccount,
            price,
            "lending_auction_purchase"
        );

        if (price >= currentDebt) {
            recoveryRouted = currentDebt;
            borrowerSurplus = price - currentDebt;
        } else {
            recoveryRouted = price;
            borrowerSurplus = 0;
        }

        if (recoveryRouted > 0) {
            uint256 applied = lendingContract.repayDebtFromVaultRecovery(
                account,
                a.marketKey,
                recoveryRouted
            );

            if (applied != recoveryRouted) revert RecoveryApplyMismatch();
        }

        uint256 debtAfterRecovery = lendingContract.getDebt(account, a.marketKey).faceValue;

        if (debtAfterRecovery > 0) {
            lendingContract.recordBorrowerMarketLoss(account, a.marketKey, debtAfterRecovery);
        }

        if (borrowerSurplus > 0) {
            vault.payFromSettlement(
                a.marketKey,
                account,
                borrowerSurplus,
                "lending_auction_surplus"
            );
        }

        a.active = false;
        a.sold = true;
        a.winner = buyerAccount;

        LendingAccount(payable(account)).transferOwnershipFromLiquidation(newOwner);
        accountRegistry.transferAccountOwner(account, newOwner);

        emit AuctionPurchased(
            account,
            a.marketKey,
            buyerAccount,
            price,
            debtSnapshot,
            recoveryRouted,
            borrowerSurplus
        );
    }

    function markAuctionExpired(address account) external {
        AuctionState storage a = auctions[account];
        if (!a.active) revert NoActiveAuction();
        if (block.timestamp <= a.endTime) revert AuctionNotExpired();

        a.active = false;

        emit AuctionExpired(account, a.marketKey);
    }

    function cancelAuction(address account) external onlyRole(GOVERNOR_ROLE) {
        AuctionState storage a = auctions[account];
        if (!a.active) revert NoActiveAuction();

        a.active = false;
        LendingAccount(payable(account)).clearLiquidation();

        emit AuctionCancelled(account);
    }

    function _sweepFreeEthToDebt(
        address account,
        bytes32 marketKey,
        uint256 debtFaceValue
    ) internal returns (uint256 swept) {
        SethxVault.EthBalancesView memory ethBal = vault.getEthBalances(account);
        uint256 freeEth = ethBal.freeEth;

        if (freeEth == 0 || debtFaceValue == 0) {
            return 0;
        }

        swept = freeEth < debtFaceValue ? freeEth : debtFaceValue;

        vault.collectFreeEthToSettlement(marketKey, account, swept, VAULT_SWEEP_REASON);

        uint256 applied = lendingContract.repayDebtFromVaultRecovery(account, marketKey, swept);
        if (applied != swept) revert SweepNotApplied();
    }

    function _setAuctionConfig(
        uint64 premiumPhaseDuration,
        uint64 parPhaseDuration,
        uint64 discountPhaseDuration,
        uint32 startPriceBps,
        uint32 parPriceBps,
        uint32 endPriceBps
    ) internal {
        if (premiumPhaseDuration == 0) revert InvalidAuctionDuration();
        if (parPhaseDuration == 0) revert InvalidAuctionDuration();
        if (discountPhaseDuration == 0) revert InvalidAuctionDuration();

        if (startPriceBps < parPriceBps) revert InvalidAuctionCurve();
        if (parPriceBps < endPriceBps) revert InvalidAuctionCurve();
        if (startPriceBps > 50_000) revert InvalidAuctionCurve();
        if (endPriceBps > BPS) revert InvalidAuctionCurve();

        auctionConfig = AuctionConfig({
            premiumPhaseDuration: premiumPhaseDuration,
            parPhaseDuration: parPhaseDuration,
            discountPhaseDuration: discountPhaseDuration,
            startPriceBps: startPriceBps,
            parPriceBps: parPriceBps,
            endPriceBps: endPriceBps
        });

        emit AuctionConfigSet(
            premiumPhaseDuration,
            parPhaseDuration,
            discountPhaseDuration,
            startPriceBps,
            parPriceBps,
            endPriceBps
        );
    }

    function _linearInterpolateBps(
        uint256 debt,
        uint256 fromBps,
        uint256 toBps,
        uint256 elapsed,
        uint256 duration
    ) internal pure returns (uint256) {
        if (duration == 0) {
            return (debt * toBps) / BPS;
        }

        if (fromBps == toBps) {
            return (debt * fromBps) / BPS;
        }

        if (fromBps > toBps) {
            uint256 diff = fromBps - toBps;
            uint256 currentBps = fromBps - ((diff * elapsed) / duration);
            return (debt * currentBps) / BPS;
        } else {
            uint256 diff = toBps - fromBps;
            uint256 currentBps = fromBps + ((diff * elapsed) / duration);
            return (debt * currentBps) / BPS;
        }
    }
}
