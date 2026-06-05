// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import { SethxVault } from "../vault/SethxVault.sol";

import { TokenSpotOrderBook } from "../markets/spot/TokenSpotOrderBook.sol";

import { OptionsOrderBook } from "../markets/options/OptionsOrderBook.sol";
import { OptionContract } from "../markets/options/OptionContract.sol";

import { FuturesContract } from "../markets/futures/FuturesContract.sol";
import { FuturesOrderBook } from "../markets/futures/FuturesOrderBook.sol";

import { MarginOptionsOrderBook } from "../markets/margin/MarginOptionsOrderBook.sol";
import { MarginOptionContract } from "../markets/margin/MarginOptionContract.sol";
import { BinaryMarginOptionsOrderBook } from "../markets/margin/BinaryMarginOptionsOrderBook.sol";
import { BinaryMarginOptionContract } from "../markets/margin/BinaryMarginOptionContract.sol";

import { LendingContract } from "../markets/lending/LendingContract.sol";
import { LendingOrderBook } from "../markets/lending/LendingOrderBook.sol";

import { RiskModule } from "../markets/lending/RiskModule.sol";

import { FuturesTypes } from "../markets/futures/FuturesTypes.sol";

interface ILiquidationAuctionBuyer {
    function buyAuctionedAccount(address account) external;
}

/// @notice Debt-aware user account wrapper.
/// @dev Blocks withdrawals while restricted, allows borrowing only through
///      LendingOrderBook, and supports full-account liquidation transfer.
contract LendingAccount {
    using SafeERC20 for IERC20;

    receive() external payable {}

    // -------- Errors --------
    error ZeroAddress();
    error NotOwner();
    error GovernorOnly();
    error LiquidationEngineOnly();
    error NotAuthorized();
    error AccountInLiquidation();
    error AccountRestricted();
    error AlreadyInLiquidation();
    error NotInLiquidation();
    error InvalidAmount();
    error EthOnly();
    error NoRepayMarket();
    error NoDebt();
    error InvalidExpiry();
    error InvalidRate();
    error InvalidOrder();
    error InsufficientETH();
    error EthTransferFailed();
    error UnexpectedAccount(address expectedAccount, address actualAccount);
    error UnexpectedVault(address expectedVault, address actualVault);

    address public owner;
    string public accountName;
    bool public isActive;
    address public immutable governor;
    address public liquidationEngine;

    SethxVault public immutable vault;
    LendingContract public immutable lendingContract;
    RiskModule public immutable riskModule;

    bool public liquidationActive;

    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event LiquidationEngineUpdated(address indexed oldEngine, address indexed newEngine);
    event LiquidationStarted(address indexed liquidationEngine);
    event LiquidationCleared(address indexed caller);
    event RescueEth(uint256 amount);
    event RescueToken(address indexed token, uint256 amount);
    event RescueNft(address indexed nft, uint256 tokenId);
    event AccountNameUpdated(string oldName, string newName);
    event AccountActiveStatusUpdated(bool oldStatus, bool newStatus);

    constructor(
        address _owner,
        address _vault,
        address _lendingContract,
        address _riskModule,
        address _governor,
        address _liquidationEngine
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (_lendingContract == address(0)) revert ZeroAddress();
        if (_riskModule == address(0)) revert ZeroAddress();
        if (_governor == address(0)) revert ZeroAddress();
        if (_liquidationEngine == address(0)) revert ZeroAddress();

        owner = _owner;
        isActive = true;
        vault = SethxVault(_vault);
        lendingContract = LendingContract(payable(_lendingContract));
        riskModule = RiskModule(_riskModule);
        governor = _governor;
        liquidationEngine = _liquidationEngine;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert GovernorOnly();
        _;
    }

    modifier onlyLiquidationEngine() {
        if (msg.sender != liquidationEngine) revert LiquidationEngineOnly();
        _;
    }

    modifier whenNotLiquidating() {
        if (liquidationActive) revert AccountInLiquidation();
        _;
    }

    modifier noRestrictedWithdrawals() {
        if (isRestricted()) revert AccountRestricted();
        _;
    }

    function setLiquidationEngine(address newLiquidationEngine) external onlyGovernor {
        if (newLiquidationEngine == address(0)) revert ZeroAddress();
        address old = liquidationEngine;
        liquidationEngine = newLiquidationEngine;
        emit LiquidationEngineUpdated(old, newLiquidationEngine);
    }

    function isInDebt() public view returns (bool) {
        return lendingContract.accountHasDebt(address(this));
    }

    function isRestricted() public view returns (bool) {
        return lendingContract.isRestricted(address(this));
    }

    function _checkRisk(address target, bytes memory data) internal view {
        if (isRestricted()) {
            riskModule.checkActionAllowed(address(this), target, data);
        }
    }

    // =========================================================
    // Liquidation control
    // =========================================================

    /// @notice Freeze borrower control once liquidation starts.
    function startLiquidation() external onlyLiquidationEngine {
        if (liquidationActive) revert AlreadyInLiquidation();
        liquidationActive = true;
        emit LiquidationStarted(msg.sender);
    }

    /// @notice Emergency/manual clear if auction is cancelled or rolled back.
    /// @dev Keep this for operational recovery; in normal success flow
    ///      transferOwnershipFromLiquidation clears the flag automatically.
    function clearLiquidation() external {
        if (msg.sender != liquidationEngine && msg.sender != governor) revert NotAuthorized();
        if (!liquidationActive) revert NotInLiquidation();
        liquidationActive = false;
        emit LiquidationCleared(msg.sender);
    }

    /// @notice Transfer account ownership after successful liquidation auction.
    /// @dev Only callable by the liquidation engine.
    function transferOwnershipFromLiquidation(address newOwner) external onlyLiquidationEngine {
        if (!liquidationActive) revert NotInLiquidation();
        if (newOwner == address(0)) revert ZeroAddress();

        address oldOwner = owner;
        owner = newOwner;
        liquidationActive = false;

        emit OwnerTransferred(oldOwner, newOwner);
        emit LiquidationCleared(msg.sender);
    }

    function setAccountName(string calldata newName) external onlyOwner whenNotLiquidating {
        string memory oldName = accountName;
        accountName = newName;
        emit AccountNameUpdated(oldName, newName);
    }

    function setActive(bool newStatus) external onlyOwner whenNotLiquidating {
        bool oldStatus = isActive;
        isActive = newStatus;
        emit AccountActiveStatusUpdated(oldStatus, newStatus);
    }

    // =========================================================
    // Vault: deposits / withdrawals
    // =========================================================

    function depositETH(
        address expectedAccount,
        address expectedVault
    ) external payable onlyOwner whenNotLiquidating {
        if (msg.value == 0) revert InvalidAmount();
        if (expectedAccount != address(this)) {
            revert UnexpectedAccount(expectedAccount, address(this));
        }

        if (expectedVault != address(vault)) {
            revert UnexpectedVault(expectedVault, address(vault));
        }

        vault.depositETH{ value: msg.value }();
    }

    function withdrawETH(
        uint256 amount
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        vault.withdrawETHTo(owner, amount);
    }

    function withdrawETHToOwnerFromLiquidation(uint256 amount) external {
        if (msg.sender != liquidationEngine) revert LiquidationEngineOnly();
        if (!liquidationActive) revert NotInLiquidation();
        vault.withdrawETHTo(owner, amount);
    }

    function depositToken(
        address token,
        uint256 amount,
        address expectedAccount,
        address expectedVault
    ) external onlyOwner whenNotLiquidating {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (expectedAccount != address(this)) {
            revert UnexpectedAccount(expectedAccount, address(this));
        }

        if (expectedVault != address(vault)) {
            revert UnexpectedVault(expectedVault, address(vault));
        }

        IERC20(token).safeTransferFrom(owner, address(this), amount);
        IERC20(token).forceApprove(address(vault), 0);
        IERC20(token).forceApprove(address(vault), amount);
        vault.depositERC20(token, amount);
    }

    function withdrawToken(
        address token,
        uint256 amount
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        vault.withdrawERC20To(token, owner, amount);
    }

    function depositNFT721(
        address nft,
        uint256 tokenId,
        address expectedAccount,
        address expectedVault
    ) external onlyOwner whenNotLiquidating {
        if (nft == address(0)) revert ZeroAddress();
        if (expectedAccount != address(this)) {
            revert UnexpectedAccount(expectedAccount, address(this));
        }

        if (expectedVault != address(vault)) {
            revert UnexpectedVault(expectedVault, address(vault));
        }

        IERC721(nft).transferFrom(owner, address(this), tokenId);
        IERC721(nft).approve(address(vault), tokenId);
        vault.depositERC721(nft, tokenId);
    }

    function withdrawNFT721(
        address nft,
        uint256 tokenId
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        vault.withdrawERC721To(nft, tokenId, owner);
    }

    // =========================================================
    // Lending repayment
    // =========================================================

    function repayDebt(
        bytes32 marketKey,
        uint256 amount
    ) external onlyOwner whenNotLiquidating returns (uint256 applied) {
        applied = _repayDebtFromVault(marketKey, amount);
    }

    function repayDebtForMarket(
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 amount
    ) external onlyOwner whenNotLiquidating returns (uint256 applied) {
        bytes32 marketKey = keccak256(abi.encode(borrowToken, marketExpiry, riskLevel));
        applied = _repayDebtFromVault(marketKey, amount);
    }

    function _repayDebtFromVault(
        bytes32 marketKey,
        uint256 amount
    ) internal returns (uint256 applied) {
        if (amount == 0) revert InvalidAmount();

        LendingContract.DebtPosition memory debt = lendingContract.getDebt(
            address(this),
            marketKey
        );
        if (debt.faceValue == 0) revert NoDebt();

        applied = amount > debt.faceValue ? debt.faceValue : amount;

        lendingContract.repayDebtFromAccountVault(marketKey, applied);
    }

    // =========================================================
    // TokenSpotOrderBook
    // =========================================================

    function placeOrderTokenSpot(
        address orderBook,
        address feeToken,
        address baseToken,
        address quoteToken,
        TokenSpotOrderBook.Side side,
        uint256 price,
        uint256 amount,
        uint256 expiry,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            TokenSpotOrderBook.placeOrder.selector,
            feeToken,
            baseToken,
            quoteToken,
            side,
            price,
            amount,
            expiry,
            referrer
        );
        _checkRisk(orderBook, data);
        TokenSpotOrderBook(orderBook).placeOrder(
            feeToken,
            baseToken,
            quoteToken,
            side,
            price,
            amount,
            expiry,
            referrer
        );
    }

    function cancelOrderTokenSpot(
        address orderBook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        TokenSpotOrderBook(orderBook).cancelOrder(orderId);
    }

    function acceptOrderTokenSpot(
        address orderBook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            TokenSpotOrderBook.acceptOrder.selector,
            makerOrderId,
            amount,
            feeToken,
            referrer
        );
        _checkRisk(orderBook, data);
        TokenSpotOrderBook(orderBook).acceptOrder(makerOrderId, amount, feeToken, referrer);
    }

    // =========================================================
    // OptionsOrderBook
    // =========================================================

    function placeOrderOption(
        address orderBook,
        OptionContract.OptionType optionType,
        address assetToken,
        address quoteToken,
        uint256 strikePrice,
        uint256 optionExpiry,
        uint256 orderExpiry,
        address feeToken,
        OptionsOrderBook.OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            OptionsOrderBook.placeOrder.selector,
            optionType,
            assetToken,
            quoteToken,
            strikePrice,
            optionExpiry,
            orderExpiry,
            feeToken,
            intent,
            size,
            askPrice,
            referrer
        );
        _checkRisk(orderBook, data);
        OptionsOrderBook(orderBook).placeOrder(
            optionType,
            assetToken,
            quoteToken,
            strikePrice,
            optionExpiry,
            orderExpiry,
            feeToken,
            intent,
            size,
            askPrice,
            referrer
        );
    }

    function cancelOrderOption(
        address orderBook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        OptionsOrderBook(orderBook).cancelOrder(orderId);
    }

    function acceptOrderOption(
        address orderBook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            OptionsOrderBook.acceptOrder.selector,
            makerOrderId,
            amount,
            feeToken,
            referrer
        );
        _checkRisk(orderBook, data);
        OptionsOrderBook(orderBook).acceptOrder(makerOrderId, amount, feeToken, referrer);
    }

    // =========================================================
    // Option lifecycle (direct)
    // =========================================================

    function exerciseOption(
        address optionContractAddr,
        bytes32 marketKey,
        uint256 size
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            OptionContract.exercise.selector,
            marketKey,
            size
        );
        _checkRisk(optionContractAddr, data);
        OptionContract(optionContractAddr).exercise(marketKey, size);
    }

    function reclaimExpiredOption(
        address optionContractAddr,
        bytes32 marketKey
    ) external onlyOwner {
        OptionContract(optionContractAddr).reclaimExpired(marketKey);
    }

    function clearExpiredOptionHolder(
        address optionContractAddr,
        bytes32 marketKey
    ) external onlyOwner {
        OptionContract(optionContractAddr).clearExpiredHolder(marketKey);
    }

    // =========================================================
    // FuturesOrderBook / FuturesContract
    // =========================================================

    function placeOrderFutures(
        address orderBook,
        bytes32 marketKey,
        FuturesOrderBook.Side intent,
        uint256 price,
        uint256 amount,
        uint256 expiry,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            FuturesOrderBook.placeOrder.selector,
            marketKey,
            intent,
            price,
            amount,
            expiry,
            feeToken,
            referrer
        );
        _checkRisk(orderBook, data);
        FuturesOrderBook(orderBook).placeOrder(
            marketKey,
            intent,
            price,
            amount,
            expiry,
            feeToken,
            referrer
        );
    }

    function cancelOrderFutures(
        address orderBook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        FuturesOrderBook(orderBook).cancelOrder(orderId);
    }

    function matchFuturesImbalance(
        address orderBook,
        bytes32 marketKey,
        uint256 maxMatches
    )
        external
        onlyOwner
        whenNotLiquidating
        returns (uint256 matchedAmount, uint256 callerReward, uint256 protocolFee)
    {
        if (orderBook == address(0)) revert ZeroAddress();
        if (maxMatches == 0) revert InvalidAmount();

        bytes memory data = abi.encodeWithSelector(
            FuturesOrderBook.matchImbalance.selector,
            marketKey,
            maxMatches
        );
        _checkRisk(orderBook, data);

        return FuturesOrderBook(orderBook).matchImbalance(marketKey, maxMatches);
    }

    function addFuturesMargin(
        address futuresContract,
        bytes32 marketKey,
        uint256 amount
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            FuturesContract.addMargin.selector,
            marketKey,
            amount
        );
        _checkRisk(futuresContract, data);
        FuturesContract(futuresContract).addMargin(marketKey, amount);
    }

    function releaseFuturesMargin(
        address futuresContract,
        bytes32 marketKey
    ) external onlyOwner whenNotLiquidating {
        bytes memory data = abi.encodeWithSelector(
            FuturesContract.releaseExcessMargin.selector,
            marketKey
        );

        _checkRisk(futuresContract, data);

        FuturesContract(futuresContract).releaseExcessMargin(marketKey);
    }

    function liquidateFuturesPosition(
        address futuresContract,
        bytes32 marketKey,
        address account
    ) external onlyOwner whenNotLiquidating returns (uint256 seizedMargin, uint256 callerReward) {
        if (futuresContract == address(0)) revert ZeroAddress();
        if (account == address(0)) revert ZeroAddress();

        return FuturesContract(futuresContract).liquidatePosition(marketKey, account);
    }

    function liquidateFuturesHead(
        address futuresContract,
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 maxSteps
    ) external onlyOwner whenNotLiquidating returns (uint256 processed) {
        if (futuresContract == address(0)) revert ZeroAddress();
        if (maxSteps == 0) revert InvalidAmount();

        return FuturesContract(futuresContract).liquidateHead(marketKey, side, maxSteps);
    }

    function rebaseFuturesLosingPositionsToBufferTarget(
        address futuresContract,
        bytes32 marketKey,
        FuturesTypes.PositionSide losingSide,
        uint256 targetSettlementBuffer,
        uint256 maxSteps
    )
        external
        onlyOwner
        whenNotLiquidating
        returns (
            uint256 scanned,
            uint256 rebased,
            uint256 amountCollected,
            uint256 settlementBufferAfter
        )
    {
        if (futuresContract == address(0)) revert ZeroAddress();
        if (maxSteps == 0) revert InvalidAmount();

        return
            FuturesContract(futuresContract).rebaseLosingPositionsToBufferTarget(
                marketKey,
                losingSide,
                targetSettlementBuffer,
                maxSteps
            );
    }

    // =========================================================
    // MarginOptionsOrderBook / MarginOptionContract
    // =========================================================

    function placeOrderMarginOption(
        address orderbook,
        bytes32 marketKey,
        MarginOptionsOrderBook.OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 expiry,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        if (orderbook == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            MarginOptionsOrderBook.placeOrder.selector,
            marketKey,
            intent,
            size,
            askPrice,
            expiry,
            feeToken,
            referrer
        );
        _checkRisk(orderbook, data);
        MarginOptionsOrderBook(orderbook).placeOrder(
            marketKey,
            intent,
            size,
            askPrice,
            expiry,
            feeToken,
            referrer
        );
    }

    function acceptOrderMarginOption(
        address orderbook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        if (orderbook == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            MarginOptionsOrderBook.acceptOrder.selector,
            makerOrderId,
            amount,
            feeToken,
            referrer
        );
        _checkRisk(orderbook, data);
        MarginOptionsOrderBook(orderbook).acceptOrder(makerOrderId, amount, feeToken, referrer);
    }

    function cancelOrderMarginOption(
        address orderbook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        if (orderbook == address(0)) revert ZeroAddress();
        MarginOptionsOrderBook(orderbook).cancelOrder(orderId);
    }

    function claimMarginOption(
        address marginOptionContract,
        bytes32 marketKey,
        uint256 size
    ) external onlyOwner {
        if (marginOptionContract == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            MarginOptionContract.claim.selector,
            marketKey,
            size
        );
        _checkRisk(marginOptionContract, data);
        MarginOptionContract(marginOptionContract).claim(marketKey, size);
    }

    function reclaimWriterMarginOption(
        address marginOptionContract,
        bytes32 marketKey
    ) external onlyOwner {
        if (marginOptionContract == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            MarginOptionContract.reclaimWriterMargin.selector,
            marketKey
        );
        _checkRisk(marginOptionContract, data);
        MarginOptionContract(marginOptionContract).reclaimWriterMargin(marketKey);
    }

    // =========================================================
    // BinaryMarginOptionsOrderBook / BinaryMarginOptionContract
    // =========================================================

    function placeOrderBinaryMarginOption(
        address orderbook,
        bytes32 marketKey,
        uint8 intent,
        uint256 payoutAmount,
        uint256 askPrice,
        uint256 expiry,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating returns (uint256) {
        if (orderbook == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            BinaryMarginOptionsOrderBook.placeOrder.selector,
            marketKey,
            intent,
            payoutAmount,
            askPrice,
            expiry,
            feeToken,
            referrer
        );
        _checkRisk(orderbook, data);
        return
            BinaryMarginOptionsOrderBook(orderbook).placeOrder(
                marketKey,
                intent,
                payoutAmount,
                askPrice,
                expiry,
                feeToken,
                referrer
            );
    }

    function acceptOrderBinaryMarginOption(
        address orderbook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken,
        address referrer
    ) external onlyOwner whenNotLiquidating {
        if (orderbook == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            BinaryMarginOptionsOrderBook.acceptOrder.selector,
            makerOrderId,
            amount,
            feeToken,
            referrer
        );
        _checkRisk(orderbook, data);
        BinaryMarginOptionsOrderBook(orderbook).acceptOrder(
            makerOrderId,
            amount,
            feeToken,
            referrer
        );
    }

    function cancelOrderBinaryMarginOption(
        address orderbook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        if (orderbook == address(0)) revert ZeroAddress();
        BinaryMarginOptionsOrderBook(orderbook).cancelOrder(orderId);
    }

    function claimBinaryMarginOption(
        address binaryMarginOptionContract,
        bytes32 marketKey,
        uint256 payoutAmount
    ) external onlyOwner {
        if (binaryMarginOptionContract == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            BinaryMarginOptionContract.claim.selector,
            marketKey,
            payoutAmount
        );
        _checkRisk(binaryMarginOptionContract, data);
        BinaryMarginOptionContract(binaryMarginOptionContract).claim(marketKey, payoutAmount);
    }

    function reclaimWriterBinaryMarginOption(
        address binaryMarginOptionContract,
        bytes32 marketKey
    ) external onlyOwner {
        if (binaryMarginOptionContract == address(0)) revert ZeroAddress();
        bytes memory data = abi.encodeWithSelector(
            BinaryMarginOptionContract.reclaimWriterMargin.selector,
            marketKey
        );
        _checkRisk(binaryMarginOptionContract, data);
        BinaryMarginOptionContract(binaryMarginOptionContract).reclaimWriterMargin(marketKey);
    }
    // LendingOrderBook (borrowing and lending)
    // =========================================================

    function buyAuctionedLendingAccount(
        address liquidation,
        address account
    ) external onlyOwner whenNotLiquidating {
        if (liquidation == address(0)) revert ZeroAddress();
        if (account == address(0)) revert ZeroAddress();

        bytes memory data = abi.encodeWithSelector(
            ILiquidationAuctionBuyer.buyAuctionedAccount.selector,
            account
        );

        _checkRisk(liquidation, data);

        ILiquidationAuctionBuyer(liquidation).buyAuctionedAccount(account);
    }

    function placeBorrowOrder(
        address lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 principal,
        uint256 rateBps,
        uint64 orderExpiry
    ) external onlyOwner whenNotLiquidating {
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (borrowToken != address(0)) revert EthOnly();
        if (principal == 0) revert InvalidAmount();
        if (rateBps == 0) revert InvalidRate();
        if (marketExpiry <= block.timestamp) revert InvalidExpiry();
        if (orderExpiry <= block.timestamp) revert InvalidExpiry();

        bytes memory data = abi.encodeWithSelector(
            LendingOrderBook.placeOrder.selector,
            borrowToken,
            marketExpiry,
            riskLevel,
            LendingOrderBook.Side.Borrow,
            rateBps,
            principal,
            orderExpiry
        );
        // Borrow orders are always risk checked, including the first borrow order
        // before LendingContract latches this account's risk level.
        riskModule.checkActionAllowed(address(this), lendingOrderBook, data);
        LendingOrderBook(lendingOrderBook).placeOrder(
            borrowToken,
            marketExpiry,
            riskLevel,
            LendingOrderBook.Side.Borrow,
            rateBps,
            principal,
            orderExpiry
        );
    }

    function cancelBorrowOrder(
        address lendingOrderBook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (orderId == 0) revert InvalidOrder();
        LendingOrderBook(lendingOrderBook).cancelOrder(orderId);
    }

    function placeRolloverBorrowOrder(
        address lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 principal,
        uint256 rateBps,
        uint64 orderExpiry,
        bytes32 repayMarketKey
    ) external onlyOwner whenNotLiquidating {
        if (borrowToken != address(0)) revert EthOnly();
        if (repayMarketKey == bytes32(0)) revert NoRepayMarket();
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (principal == 0) revert InvalidAmount();
        if (rateBps == 0) revert InvalidRate();
        if (marketExpiry <= block.timestamp) revert InvalidExpiry();
        if (orderExpiry <= block.timestamp) revert InvalidExpiry();

        bytes memory data = abi.encodeWithSelector(
            LendingOrderBook.placeRolloverBorrowOrder.selector,
            borrowToken,
            marketExpiry,
            riskLevel,
            rateBps,
            principal,
            orderExpiry,
            repayMarketKey
        );
        riskModule.checkActionAllowed(address(this), lendingOrderBook, data);
        LendingOrderBook(lendingOrderBook).placeRolloverBorrowOrder(
            borrowToken,
            marketExpiry,
            riskLevel,
            rateBps,
            principal,
            orderExpiry,
            repayMarketKey
        );
    }

    function placeLendOrder(
        address lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry
    ) external onlyOwner whenNotLiquidating {
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (borrowToken != address(0)) revert EthOnly();
        if (marketExpiry <= block.timestamp) revert InvalidExpiry();
        if (rateBps == 0) revert InvalidRate();
        if (principal == 0) revert InvalidAmount();
        if (orderExpiry <= block.timestamp) revert InvalidExpiry();

        LendingOrderBook(lendingOrderBook).placeOrder(
            borrowToken,
            marketExpiry,
            riskLevel,
            LendingOrderBook.Side.Lend,
            rateBps,
            principal,
            orderExpiry
        );
    }

    function cancelLendOrder(
        address lendingOrderBook,
        uint256 orderId
    ) external onlyOwner whenNotLiquidating {
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (orderId == 0) revert InvalidOrder();
        LendingOrderBook(lendingOrderBook).cancelOrder(orderId);
    }

    function redeemInitialLendingBond(uint256 bondIndex) external onlyOwner {
        lendingContract.redeemInitial(bondIndex);
    }

    function claimSupplementalLendingBond(uint256 bondIndex) external onlyOwner {
        lendingContract.claimSupplemental(bondIndex);
    }

    // =========================================================
    // Rescue functions (only for assets mistakenly sent to Account)
    // =========================================================

    function rescueEth(
        uint256 amount
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        if (address(this).balance < amount) revert InsufficientETH();

        (bool success, ) = payable(owner).call{ value: amount }("");
        if (!success) revert EthTransferFailed();
        emit RescueEth(amount);
    }

    function rescueToken(
        address token,
        uint256 amount
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(owner, amount);
        emit RescueToken(token, amount);
    }

    function rescueNFT721(
        address nft,
        uint256 tokenId
    ) external onlyOwner whenNotLiquidating noRestrictedWithdrawals {
        if (nft == address(0)) revert ZeroAddress();
        IERC721(nft).safeTransferFrom(address(this), owner, tokenId);
        emit RescueNft(nft, tokenId);
    }
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
