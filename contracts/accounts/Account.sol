// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { SethxVault } from "../vault/SethxVault.sol";

import { TokenSpotOrderBook } from "../markets/spot/TokenSpotOrderBook.sol";
import { NFTSpotOrderBook } from "../markets/spot/NFTSpotOrderBook.sol";

import { OptionsOrderBook } from "../markets/options/OptionsOrderBook.sol";
import { OptionContract } from "../markets/options/OptionContract.sol";

import { FuturesContract } from "../markets/futures/FuturesContract.sol";
import { FuturesOrderBook } from "../markets/futures/FuturesOrderBook.sol";

import { MarginOptionsOrderBook } from "../markets/margin/MarginOptionsOrderBook.sol";
import { MarginOptionContract } from "../markets/margin/MarginOptionContract.sol";
import { BinaryMarginOptionsOrderBook } from "../markets/margin/BinaryMarginOptionsOrderBook.sol";
import { BinaryMarginOptionContract } from "../markets/margin/BinaryMarginOptionContract.sol";

import { LendingOrderBook } from "../markets/lending/LendingOrderBook.sol";
import { LendingContract } from "../markets/lending/LendingContract.sol";

interface ILiquidationAuctionBuyer {
    function buyAuctionedAccount(address account) external;
}

/// @notice User Account wrapper (EOA-owner controlled).
/// - Holds no core protocol state; forwards calls to Vault/OrderBooks/Contracts
/// - Must be whitelisted in AccountRegistry to pass `onlyAccount` checks.
/// - Trader interacts with Vault ONLY via this Account (except view functions).
contract Account {
    using SafeERC20 for IERC20;

    receive() external payable {}

    // -------- Errors --------
    error ZeroAddress();
    error NotOwner();
    error NotPendingOwner();
    error InvalidAmount();
    error InvalidTarget();
    error EthTransferFailed();
    error InsufficientETH();
    error InvalidOrder();
    error InvalidExpiry();
    error InvalidRate();
    error EthOnly();
    error UnexpectedAccount(address expectedAccount, address actualAccount);
    error UnexpectedVault(address expectedVault, address actualVault);

    address public owner;
    address public pendingOwner;
    string public accountName;
    bool public isActive;
    SethxVault public immutable vault;

    event RescueEth(uint256 amount);
    event RescueToken(address indexed token, uint256 amount);
    event RescueNft(address indexed nft, uint256 tokenId);
    event AccountNameUpdated(string oldName, string newName);
    event AccountActiveStatusUpdated(bool oldStatus, bool newStatus);

    constructor(address _owner, address _vault) {
        if (_owner == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        owner = _owner;
        isActive = true;
        vault = SethxVault(_vault);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // =========================================================
    // Ownership
    // =========================================================

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
    }

    function setAccountName(string calldata newName) external onlyOwner {
        string memory oldName = accountName;
        accountName = newName;
        emit AccountNameUpdated(oldName, newName);
    }

    function setActive(bool newStatus) external onlyOwner {
        bool oldStatus = isActive;
        isActive = newStatus;
        emit AccountActiveStatusUpdated(oldStatus, newStatus);
    }

    // =========================================================
    // Vault: deposits / withdrawals
    // =========================================================

    /// @notice Deposit ETH into vault (vault credits msg.sender (Account) balance).
    function depositETH(address expectedAccount, address expectedVault) external payable onlyOwner {
        if (msg.value == 0) revert InvalidAmount();
        if (expectedAccount != address(this)) {
            revert UnexpectedAccount(expectedAccount, address(this));
        }

        if (expectedVault != address(vault)) {
            revert UnexpectedVault(expectedVault, address(vault));
        }
        vault.depositETH{ value: msg.value }();
    }

    /// @notice Withdraw ETH from vault to owner EOA.
    function withdrawETH(uint256 amount) external onlyOwner {
        vault.withdrawETHTo(owner, amount);
    }

    /// @notice Deposit ERC20 into vault.
    /// @dev Owner must approve THIS Account for `amount` first.
    function depositToken(
        address token,
        uint256 amount,
        address expectedAccount,
        address expectedVault
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (expectedAccount != address(this)) {
            revert UnexpectedAccount(expectedAccount, address(this));
        }

        if (expectedVault != address(vault)) {
            revert UnexpectedVault(expectedVault, address(vault));
        }

        // Pull to Account
        IERC20(token).safeTransferFrom(owner, address(this), amount);

        // Approve vault to pull
        IERC20(token).forceApprove(address(vault), 0);
        IERC20(token).forceApprove(address(vault), amount);

        // Vault pulls from Account and credits Account balance
        vault.depositERC20(token, amount);
    }

    /// @notice Withdraw ERC20 from vault to owner EOA.
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        vault.withdrawERC20To(token, owner, amount);
    }

    /// @notice Deposit ERC721 into vault.
    /// @dev Owner must approve THIS Account for tokenId first.
    function depositNFT721(
        address nft,
        uint256 tokenId,
        address expectedAccount,
        address expectedVault
    ) external onlyOwner {
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

    /// @notice Withdraw ERC721 from vault to owner EOA.
    function withdrawNFT721(address nft, uint256 tokenId) external onlyOwner {
        vault.withdrawERC721To(nft, tokenId, owner);
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
        uint256 expiry
    ) external onlyOwner {
        TokenSpotOrderBook(orderBook).placeOrder(
            feeToken,
            baseToken,
            quoteToken,
            side,
            price,
            amount,
            expiry
        );
    }

    function cancelOrderTokenSpot(address orderBook, uint256 orderId) external onlyOwner {
        TokenSpotOrderBook(orderBook).cancelOrder(orderId);
    }

    function acceptOrderTokenSpot(
        address orderBook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyOwner {
        TokenSpotOrderBook(orderBook).acceptOrder(makerOrderId, amount, feeToken);
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
        uint256 askPrice
    ) external onlyOwner {
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
            askPrice
        );
    }

    function cancelOrderOption(address orderBook, uint256 orderId) external onlyOwner {
        OptionsOrderBook(orderBook).cancelOrder(orderId);
    }

    function acceptOrderOption(
        address orderBook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyOwner {
        OptionsOrderBook(orderBook).acceptOrder(makerOrderId, amount, feeToken);
    }

    // =========================================================
    // Option lifecycle (direct)
    // =========================================================

    function exerciseOption(
        address optionContractAddr,
        bytes32 marketKey,
        uint256 size
    ) external onlyOwner {
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
    // FuturesOrderBook
    // =========================================================

    function placeOrderFutures(
        address orderBook,
        bytes32 marketKey,
        FuturesOrderBook.Side intent,
        uint256 price,
        uint256 amount,
        uint256 expiry,
        address feeToken
    ) external onlyOwner {
        FuturesOrderBook(orderBook).placeOrder(marketKey, intent, price, amount, expiry, feeToken);
    }

    function cancelOrderFutures(address orderBook, uint256 orderId) external onlyOwner {
        FuturesOrderBook(orderBook).cancelOrder(orderId);
    }

    // ---- FuturesContract (margin management) ------------

    function addFuturesMargin(
        address futuresContract,
        bytes32 marketKey,
        bool isLong,
        uint256 amount
    ) external onlyOwner {
        FuturesContract(futuresContract).addMargin(marketKey, isLong, amount);
    }

    function releaseFuturesMargin(
        address futuresContract,
        bytes32 marketKey,
        bool isLong
    ) external onlyOwner {
        FuturesContract(futuresContract).releaseExcessMargin(marketKey, isLong);
    }

    // =========================================================
    // MarginOptionsOrderBook
    // =========================================================

    function placeOrderMarginOption(
        address orderbook,
        bytes32 marketKey,
        MarginOptionsOrderBook.OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 expiry,
        address feeToken
    ) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        return
            MarginOptionsOrderBook(orderbook).placeOrder(
                marketKey,
                intent,
                size,
                askPrice,
                expiry,
                feeToken
            );
    }

    function placeOrderMarginOptionForMarket(
        address orderbook,
        string calldata ticker,
        MarginOptionContract.OptionType optionType,
        address oracle,
        uint256 strikePrice,
        uint256 marketExpiry,
        uint256 collateralBps,
        MarginOptionsOrderBook.OrderIntent intent,
        uint256 size,
        uint256 askPrice,
        uint256 expiry,
        address feeToken
    ) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        MarginOptionsOrderBook(orderbook).placeOrderForMarket(
            ticker, optionType, oracle, strikePrice, marketExpiry, collateralBps,
            intent, size, askPrice, expiry, feeToken
        );
    }

    function acceptOrderMarginOption(
        address orderbook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        MarginOptionsOrderBook(orderbook).acceptOrder(makerOrderId, amount, feeToken);
    }

    function cancelOrderMarginOption(address orderbook, uint256 orderId) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        MarginOptionsOrderBook(orderbook).cancelOrder(orderId);
    }

    //===============================================
    // MarginOptionContract
    //===============================================

    function claimMarginOption(
        address marginOptionContract,
        bytes32 marketKey,
        uint256 size
    ) external onlyOwner {
        if (marginOptionContract == address(0)) revert ZeroAddress();
        MarginOptionContract(marginOptionContract).claim(marketKey, size);
    }

    function reclaimWriterMarginOption(
        address marginOptionContract,
        bytes32 marketKey
    ) external onlyOwner {
        if (marginOptionContract == address(0)) revert ZeroAddress();
        MarginOptionContract(marginOptionContract).reclaimWriterMargin(marketKey);
    }

    //===============================================
    // BinaryMarginOptionsOrderBook
    //===============================================
    function placeOrderBinaryMarginOption(
        address orderbook,
        bytes32 marketKey,
        uint8 intent,
        uint256 payoutAmount,
        uint256 askPrice,
        uint256 expiry,
        address feeToken
    ) external onlyOwner returns (uint256) {
        if (orderbook == address(0)) revert ZeroAddress();
        return
            BinaryMarginOptionsOrderBook(orderbook).placeOrder(
                marketKey,
                intent,
                payoutAmount,
                askPrice,
                expiry,
                feeToken
            );
    }

    function placeOrderBinaryMarginOptionForMarket(
        address orderbook,
        string calldata ticker,
        BinaryMarginOptionContract.OptionType optionType,
        address oracle,
        uint256 strikePrice,
        uint256 marketExpiry,
        uint8 intent,
        uint256 payoutAmount,
        uint256 askPrice,
        uint256 expiry,
        address feeToken
    ) external onlyOwner returns (uint256) {
        if (orderbook == address(0)) revert ZeroAddress();
        return BinaryMarginOptionsOrderBook(orderbook).placeOrderForMarket(
            ticker, optionType, oracle, strikePrice, marketExpiry,
            intent, payoutAmount, askPrice, expiry, feeToken
        );
    }

    function acceptOrderBinaryMarginOption(
        address orderbook,
        uint256 makerOrderId,
        uint256 amount,
        address feeToken
    ) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        BinaryMarginOptionsOrderBook(orderbook).acceptOrder(makerOrderId, amount, feeToken);
    }

    function cancelOrderBinaryMarginOption(address orderbook, uint256 orderId) external onlyOwner {
        if (orderbook == address(0)) revert ZeroAddress();
        BinaryMarginOptionsOrderBook(orderbook).cancelOrder(orderId);
    }

    //===============================================
    // BinaryMarginOptionContract
    //===============================================
    function claimBinaryMarginOption(
        address binaryMarginOptionContract,
        bytes32 marketKey,
        uint256 payoutAmount
    ) external onlyOwner {
        require(binaryMarginOptionContract != address(0), "Zero address");
        BinaryMarginOptionContract(binaryMarginOptionContract).claim(marketKey, payoutAmount);
    }

    function reclaimWriterBinaryMarginOption(
        address binaryMarginOptionContract,
        bytes32 marketKey
    ) external onlyOwner {
        require(binaryMarginOptionContract != address(0), "Zero address");
        BinaryMarginOptionContract(binaryMarginOptionContract).reclaimWriterMargin(marketKey);
    }

    //===============================================
    // NFTSpotOrderBook
    //===============================================

    function placeOrderNFTSpot(
        address orderBook,
        address feeToken,
        address nft,
        uint256 tokenId,
        address quoteToken,
        NFTSpotOrderBook.Side side,
        uint256 price,
        uint256 expiry
    ) external onlyOwner {
        NFTSpotOrderBook(orderBook).placeOrder(
            feeToken,
            nft,
            tokenId,
            quoteToken,
            side,
            price,
            expiry
        );
    }

    function acceptOrderNFTSpot(
        address orderBook,
        uint256 makerOrderId,
        address feeToken
    ) external onlyOwner {
        NFTSpotOrderBook(orderBook).acceptOrder(makerOrderId, feeToken);
    }

    function cancelOrderNFTSpot(address orderBook, uint256 orderId) external onlyOwner {
        NFTSpotOrderBook(orderBook).cancelOrder(orderId);
    }

    //===============================================
    // LendingOrderBook
    //===============================================

    function buyAuctionedLendingAccount(
        address liquidationEngine,
        address account
    ) external onlyOwner {
        ILiquidationAuctionBuyer(liquidationEngine).buyAuctionedAccount(account);
    }

    function placeLendOrder(
        address lendingOrderBook,
        address borrowToken,
        uint64 marketExpiry,
        uint16 riskLevel,
        uint256 rateBps,
        uint256 principal,
        uint64 orderExpiry
    ) external onlyOwner {
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

    function cancelLendOrder(address lendingOrderBook, uint256 orderId) external onlyOwner {
        if (lendingOrderBook == address(0)) revert ZeroAddress();
        if (orderId == 0) revert InvalidOrder();

        LendingOrderBook(lendingOrderBook).cancelOrder(orderId);
    }

    function redeemInitialLendingBond(
        address lendingContract,
        uint256 bondIndex
    ) external onlyOwner {
        if (lendingContract == address(0)) revert ZeroAddress();
        LendingContract(payable(lendingContract)).redeemInitial(bondIndex);
    }

    function claimSupplementalLendingBond(
        address lendingContract,
        uint256 bondIndex
    ) external onlyOwner {
        if (lendingContract == address(0)) revert ZeroAddress();
        LendingContract(payable(lendingContract)).claimSupplemental(bondIndex);
    }

    // =========================================================
    // Rescue functions (only for assets mistakenly sent to Account)
    // =========================================================

    function rescueEth(uint256 amount) external onlyOwner {
        if (address(this).balance < amount) revert InsufficientETH();
        (bool success, ) = payable(owner).call{ value: amount }("");
        if (!success) revert EthTransferFailed();
        emit RescueEth(amount);
    }

    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(owner, amount);
        emit RescueToken(token, amount);
    }

    function rescueNFT721(address nft, uint256 tokenId) external onlyOwner {
        if (nft == address(0)) revert ZeroAddress();
        IERC721(nft).safeTransferFrom(address(this), owner, tokenId);
        emit RescueNft(nft, tokenId);
    }

    // =========================================================
    // ERC Receiver hooks (needed for 721 rescue paths)
    // =========================================================

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
