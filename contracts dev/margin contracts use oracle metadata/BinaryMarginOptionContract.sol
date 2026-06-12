// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { PriceManager } from "../../oracle/PriceManager.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { IPriceOracle } from "../../oracle/interfaces/IPriceOracle.sol";

/**
 * @notice Binary payout option ledger settled in quote token only.
 *
 * Product model
 * - Governor approves oracle usage in PriceManager.
 * - Anyone can create a Friday-noon market for an approved oracle / strike / expiry; strike increment is contract-derived.
 * - Orders trade a payout amount, not a "size".
 * - Writer locks exactly the payout amount.
 * - Buyer pays premium = payoutAmount * askPrice / 1e18.
 * - If ITM at settlement, holder claims the payout amount.
 * - If OTM, holder claims 0.
 */
contract BinaryMarginOptionContract is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");
    uint256 public constant WAD = 1e18;

    uint256 public settlementPriceMaxWait = 1 hours;
    /// @dev Strike granularity control: tick ~= magnitude / strikeDivider. Governor can adjust.
    uint256 public strikeDivider = 50;

    error ZeroAddress();
    error Unauthorized();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidStrike();
    error InvalidIncrement();
    error InvalidStrikeDivider();
    error InvalidExpiry();
    error InvalidOracle();
    error InvalidOracleMetadata();
    error InvalidPaymentToken();
    error PriceManagerNotSet();
    error MarketAlreadyExists();
    error MarketNotInitialized();
    error MarketIsClosed();
    error MarketExpired();
    error MarketAlreadySettled();
    error MarketNotSettled();
    error MarketUnavailable();
    error InsufficientHolderPayout();
    error InsufficientWriterPayout();
    error InsufficientWriterMargin();
    error InsufficientWriterCapacity();
    error NothingToClaim();
    error NothingToReclaim();
    error ClaimsOutstanding();
    error IndexOutOfRange();
    error BadSettlementPrice();
    error ZeroSettlementPrice();
    error InvalidSettlementPriceMaxWait();

    enum OptionType {
        Call,
        Put
    }

    struct HolderPosition {
        uint256 payoutBought;
        uint256 payoutClaimed;
    }

    struct WriterPosition {
        uint256 payoutWritten;
        uint256 payoutAllocated; // payout already assigned to holder claims
        uint256 lockedMargin; // actual quote-token margin locked for this writer
        uint256 paidOut; // actual quote-token payout already paid
    }

    struct MarketConfig {
        bool initialized;
        bool active;
        bool settled;
        OptionType optionType;
        string ticker;
        address oracle;
        address paymentToken; // always ETH/address(0)
        uint8 oraclePriceDecimals;
        uint8 paymentTokenDecimals; // always 18
        uint256 strikePrice; // normalized to quote token decimals
        uint256 strikeIncrement; // normalized to quote token decimals
        uint256 expiry;
        uint256 settlementPrice; // normalized to quote token decimals
        bool settlementPricePending;
        uint256 settlementPriceRequestedAt;
        uint256 totalPayout;
        uint256 totalClaimed;
        uint256 totalWriterMargin;
        uint256 totalPaidOut;
    }

    AccountRegistry public immutable accountRegistry;
    SethxVault public immutable vault;
    PriceManager public priceManager;

    mapping(bytes32 => MarketConfig) public markets;
    mapping(bytes32 => mapping(address => HolderPosition)) public holders;
    mapping(bytes32 => mapping(address => WriterPosition)) public writers;

    mapping(bytes32 => EnumerableSet.AddressSet) private holderSet;
    mapping(bytes32 => EnumerableSet.AddressSet) private writerSet;

    mapping(bytes32 => address[]) private writerQueue;
    mapping(bytes32 => mapping(address => bool)) private writerQueued;
    mapping(bytes32 => uint256) public writerCursor;

    bytes32[] private _marketKeys;
    mapping(bytes32 => uint256) private _marketKeyIndexPlus1;

    mapping(bytes32 => uint256) public marketOpenInterest;

    event MarketCreated(
        bytes32 indexed marketKey,
        OptionType optionType,
        address indexed oracle,
        address indexed paymentToken,
        uint256 normalizedStrike,
        uint256 expiry,
        uint256 strikeIncrement,
        string ticker
    );
    event MarketOpened(bytes32 indexed marketKey);
    event MarketClosed(bytes32 indexed marketKey);
    event SettlementPriceSet(bytes32 indexed marketKey, uint256 settlementPrice, bool isITM);
    event SettlementPricePending(
        bytes32 indexed marketKey,
        uint256 requestedAt,
        uint256 expiry,
        uint256 lastPriceTimestamp
    );
    event SettlementPriceMaxWaitUpdated(uint256 oldWait, uint256 newWait);
    event StrikeDividerUpdated(uint256 oldDivider, uint256 newDivider);

    event BinaryMarginOptionRegistered(
        bytes32 indexed marketKey,
        address indexed writer,
        address indexed holder,
        uint256 payoutAmount,
        uint256 lockedMargin
    );

    event HolderPositionTransferred(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed to,
        uint256 payoutAmount
    );

    event WriterPositionTransferred(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed to,
        uint256 payoutAmount,
        uint256 lockedMargin
    );

    event HolderClaimed(
        bytes32 indexed marketKey,
        address indexed holder,
        uint256 payoutAmount,
        uint256 actualPayout
    );

    event WriterReclaimed(
        bytes32 indexed marketKey,
        address indexed writer,
        uint256 reclaimedAmount
    );

    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }
        _;
    }

    constructor(address _vault, address _accountRegistry, address admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    function setPriceManager(address _priceManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_priceManager == address(0)) revert ZeroAddress();
        priceManager = PriceManager(_priceManager);
    }

    function setSettlementPriceMaxWait(uint256 newWait) external onlyRole(GOVERNOR_ROLE) {
        if (newWait == 0) revert InvalidSettlementPriceMaxWait();
        uint256 oldWait = settlementPriceMaxWait;
        settlementPriceMaxWait = newWait;
        emit SettlementPriceMaxWaitUpdated(oldWait, newWait);
    }

    function marketCount() external view returns (uint256) {
        return _marketKeys.length;
    }

    function marketKeyAt(uint256 index) external view returns (bytes32) {
        if (index >= _marketKeys.length) revert IndexOutOfRange();
        return _marketKeys[index];
    }

    function getMarketKeys() external view returns (bytes32[] memory) {
        return _marketKeys;
    }

    function getMarket(bytes32 marketKey) external view returns (MarketConfig memory) {
        return markets[marketKey];
    }

    function getMarketTradingData(
        bytes32 marketKey
    )
        external
        view
        returns (bool initialized, bool active, bool settled, address quoteToken, uint256 expiry)
    {
        MarketConfig storage m = markets[marketKey];
        return (m.initialized, m.active, m.settled, m.paymentToken, m.expiry);
    }

    function getQuoteToken(bytes32 marketKey) external view returns (address) {
        return markets[marketKey].paymentToken;
    }

    function getHolderClaimablePayout(
        bytes32 marketKey,
        address holder
    ) external view returns (uint256) {
        HolderPosition storage hp = holders[marketKey][holder];
        return hp.payoutBought > hp.payoutClaimed ? (hp.payoutBought - hp.payoutClaimed) : 0;
    }

    function getWriterAvailablePayout(
        bytes32 marketKey,
        address writer
    ) external view returns (uint256) {
        WriterPosition storage wp = writers[marketKey][writer];
        return wp.payoutWritten > wp.payoutAllocated ? (wp.payoutWritten - wp.payoutAllocated) : 0;
    }

    function getWriterAvailableMargin(
        bytes32 marketKey,
        address writer
    ) external view returns (uint256) {
        WriterPosition storage wp = writers[marketKey][writer];
        return wp.lockedMargin > wp.paidOut ? (wp.lockedMargin - wp.paidOut) : 0;
    }

    function getHolderAddresses(bytes32 marketKey) external view returns (address[] memory out) {
        uint256 len = holderSet[marketKey].length();
        out = new address[](len);
        for (uint256 i = 0; i < len; i++) out[i] = holderSet[marketKey].at(i);
    }

    function getWriterAddresses(bytes32 marketKey) external view returns (address[] memory out) {
        uint256 len = writerSet[marketKey].length();
        out = new address[](len);
        for (uint256 i = 0; i < len; i++) out[i] = writerSet[marketKey].at(i);
    }
    function setStrikeDivider(uint256 newDivider) external onlyRole(GOVERNOR_ROLE) {
        if (newDivider == 0) revert InvalidStrikeDivider();
        uint256 old = strikeDivider;
        strikeDivider = newDivider;
        emit StrikeDividerUpdated(old, newDivider);
    }


    function computeMarketKey(
        OptionType optionType,
        address oracle,
        address paymentToken,
        uint256 strikePrice,
        uint256 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(optionType, oracle, paymentToken, strikePrice, expiry));
    }

    /// @notice Returns true iff `expiry` is exactly Friday 12:00 UTC.
    function isValidExpiry(uint256 expiry) public pure returns (bool) {
        uint256 day = expiry / 1 days;
        uint256 weekday = (day + 4) % 7;
        if (weekday != 5) return false;
        return (expiry % 1 days) == 12 hours;
    }

    function requireValidExpiry(uint256 expiry) public pure {
        if (!isValidExpiry(expiry)) revert InvalidExpiry();
    }

    function _floorLog10(uint256 x) internal pure returns (uint256 n) {
        while (x >= 10) {
            x /= 10;
            n++;
        }
    }

    function _pow10(uint256 n) internal pure returns (uint256 out) {
        out = 1;
        while (n > 0) {
            out *= 10;
            n--;
        }
    }

    /// @notice Returns the strike tick size implied by `strikeDivider` for a given normalized strike.
    function tickForStrike(uint256 strikePrice) public view returns (uint256) {
        if (strikePrice == 0) revert InvalidStrike();
        uint256 mag = _pow10(_floorLog10(strikePrice));
        uint256 tick = mag / strikeDivider;
        if (tick == 0) tick = 1;
        return tick;
    }

    /// @notice Normalizes `strikePrice` to the nearest valid strike on the contract-defined tick grid.
    function normalizeStrike(uint256 strikePrice) public view returns (uint256) {
        if (strikePrice == 0) revert InvalidStrike();
        uint256 tick = tickForStrike(strikePrice);
        uint256 half = tick / 2;
        return ((strikePrice + half) / tick) * tick;
    }

    function previewMarketKey(
        OptionType optionType,
        address oracle,
        uint256 strikePriceInput,
        uint256 expiry
    ) public view returns (bytes32 marketKey, uint256 normalizedStrike, uint256 normalizedStrikeIncrement) {
        uint8 paymentDec = 18;
        uint8 oracleDec = IPriceOracle(oracle).decimals();
        uint256 strikeInputNorm = _normalizePrice(strikePriceInput, oracleDec, paymentDec);
        normalizedStrike = normalizeStrike(strikeInputNorm);
        normalizedStrikeIncrement = tickForStrike(strikeInputNorm);
        marketKey = computeMarketKey(optionType, oracle, address(0), normalizedStrike, expiry);
    }

    function _tickerFromOracle(address oracle) internal view returns (string memory ticker) {
        (ticker, , ) = IPriceOracle(oracle).metadata();
        if (bytes(ticker).length == 0) revert InvalidOracleMetadata();
    }

    function createMarket(
        OptionType optionType,
        address oracle,
        uint256 strikePriceInput,
        uint256 expiry
    ) public returns (bytes32 marketKey) {
        if (expiry <= block.timestamp) revert InvalidExpiry();
        requireValidExpiry(expiry);
        if (address(priceManager) == address(0)) revert PriceManagerNotSet();
        if (oracle == address(0)) revert ZeroAddress();

        if (
            !priceManager.isOracleUsableForContext(
                oracle,
                PriceManager.OracleContext.OPTION_SETTLEMENT
            )
        ) {
            revert InvalidOracle();
        }

        address paymentToken = address(0);
        uint8 paymentDec = 18;
        uint8 oracleDec = IPriceOracle(oracle).decimals();
        // Ticker/display label is oracle-derived so permissionless creators cannot poison metadata.
        string memory ticker = _tickerFromOracle(oracle);

        uint256 strikeInputNorm = _normalizePrice(strikePriceInput, oracleDec, paymentDec);
        uint256 strikeIncrementNorm = tickForStrike(strikeInputNorm);
        uint256 strikePrice = normalizeStrike(strikeInputNorm);

        marketKey = computeMarketKey(optionType, oracle, paymentToken, strikePrice, expiry);
        if (markets[marketKey].initialized) revert MarketAlreadyExists();

        markets[marketKey] = MarketConfig({
            initialized: true,
            active: true,
            settled: false,
            optionType: optionType,
            ticker: ticker,
            oracle: oracle,
            paymentToken: paymentToken,
            oraclePriceDecimals: oracleDec,
            paymentTokenDecimals: paymentDec,
            strikePrice: strikePrice,
            strikeIncrement: strikeIncrementNorm,
            expiry: expiry,
            settlementPrice: 0,
            settlementPricePending: false,
            settlementPriceRequestedAt: 0,
            totalPayout: 0,
            totalClaimed: 0,
            totalWriterMargin: 0,
            totalPaidOut: 0
        });

        _marketKeys.push(marketKey);
        _marketKeyIndexPlus1[marketKey] = _marketKeys.length;

        emit MarketCreated(
            marketKey,
            optionType,
            oracle,
            paymentToken,
            strikePrice,
            expiry,
            strikeIncrementNorm,
            ticker
        );
        emit MarketOpened(marketKey);
    }

    function setMarketActive(bytes32 marketKey, bool active) external onlyRole(GOVERNOR_ROLE) {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        m.active = active;
        if (active) emit MarketOpened(marketKey);
        else emit MarketClosed(marketKey);
    }

    function registerNewPosition(
        bytes32 marketKey,
        address writer,
        address holder,
        uint256 payoutAmount,
        uint256 lockedMargin
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (payoutAmount == 0) revert InvalidAmount();
        if (writer == address(0) || holder == address(0)) revert ZeroAddress();
        if (lockedMargin != payoutAmount) revert InsufficientWriterMargin();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.active) revert MarketIsClosed();
        if (block.timestamp >= m.expiry) revert MarketExpired();

        holders[marketKey][holder].payoutBought += payoutAmount;

        writers[marketKey][writer].payoutWritten += payoutAmount;
        writers[marketKey][writer].lockedMargin += lockedMargin;

        holderSet[marketKey].add(holder);
        writerSet[marketKey].add(writer);

        if (!writerQueued[marketKey][writer]) {
            writerQueued[marketKey][writer] = true;
            writerQueue[marketKey].push(writer);
        }

        m.totalPayout += payoutAmount;
        m.totalWriterMargin += lockedMargin;
        marketOpenInterest[marketKey] += payoutAmount;

        emit BinaryMarginOptionRegistered(marketKey, writer, holder, payoutAmount, lockedMargin);
    }

    function transferHolderPosition(
        bytes32 marketKey,
        address from,
        address to,
        uint256 payoutAmount
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (payoutAmount == 0) revert InvalidAmount();
        if (from == address(0) || to == address(0) || from == to) {
            revert InvalidAccount();
        }

        HolderPosition storage hpFrom = holders[marketKey][from];
        HolderPosition storage hpTo = holders[marketKey][to];

        uint256 available =
            hpFrom.payoutBought > hpFrom.payoutClaimed
                ? (hpFrom.payoutBought - hpFrom.payoutClaimed)
                : 0;

        if (available < payoutAmount) revert InsufficientHolderPayout();

        hpFrom.payoutBought -= payoutAmount;
        hpTo.payoutBought += payoutAmount;

        if (hpFrom.payoutBought == hpFrom.payoutClaimed) {
            holderSet[marketKey].remove(from);
        }
        holderSet[marketKey].add(to);

        emit HolderPositionTransferred(marketKey, from, to, payoutAmount);
    }

    function transferWriterPosition(
        bytes32 marketKey,
        address from,
        address to,
        uint256 payoutAmount,
        uint256 lockedMargin
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (payoutAmount == 0) revert InvalidAmount();
        if (lockedMargin != payoutAmount) revert InsufficientWriterMargin();
        if (from == address(0) || to == address(0) || from == to) {
            revert InvalidAccount();
        }

        WriterPosition storage wpFrom = writers[marketKey][from];
        WriterPosition storage wpTo = writers[marketKey][to];

        uint256 availablePayout =
            wpFrom.payoutWritten > wpFrom.payoutAllocated
                ? (wpFrom.payoutWritten - wpFrom.payoutAllocated)
                : 0;

        if (availablePayout < payoutAmount) revert InsufficientWriterPayout();

        uint256 availableMargin =
            wpFrom.lockedMargin > wpFrom.paidOut ? (wpFrom.lockedMargin - wpFrom.paidOut) : 0;

        if (availableMargin < lockedMargin) revert InsufficientWriterMargin();

        wpFrom.payoutWritten -= payoutAmount;
        wpFrom.lockedMargin -= lockedMargin;

        wpTo.payoutWritten += payoutAmount;
        wpTo.lockedMargin += lockedMargin;

        if (wpFrom.payoutWritten == wpFrom.payoutAllocated) {
            writerSet[marketKey].remove(from);
        }

        writerSet[marketKey].add(to);
        if (!writerQueued[marketKey][to]) {
            writerQueued[marketKey][to] = true;
            writerQueue[marketKey].push(to);
        }

        emit WriterPositionTransferred(marketKey, from, to, payoutAmount, lockedMargin);
    }

    /**
     * @notice Permissionless oracle-based settlement.
     * @dev Uses the first PriceManager-stored oracle price at or after expiry. If that
     *      price is not available yet, starts a bounded pending window and asks
     *      PriceManager to fetch/sync. After the max wait, settles using the stored
     *      last known price so settlement cannot be blocked indefinitely.
     */
    function settleMarket(bytes32 marketKey) external returns (bool settledNow) {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (block.timestamp < m.expiry) revert MarketUnavailable();
        if (m.settled) revert MarketAlreadySettled();
        if (address(priceManager) == address(0)) revert PriceManagerNotSet();

        (uint256 rawPrice, uint256 priceTimestamp) = _readStoredOraclePrice(m);

        if (rawPrice != 0 && priceTimestamp >= m.expiry) {
            _finalizeSettlementPrice(marketKey, m, rawPrice);
            return true;
        }

        if (!m.settlementPricePending) {
            m.settlementPricePending = true;
            m.settlementPriceRequestedAt = block.timestamp;
            emit SettlementPricePending(
                marketKey,
                m.settlementPriceRequestedAt,
                m.expiry,
                priceTimestamp
            );
        }

        _tryRefreshSettlementOracle(m.oracle);
        (rawPrice, priceTimestamp) = _readStoredOraclePrice(m);

        if (rawPrice != 0 && priceTimestamp >= m.expiry) {
            _finalizeSettlementPrice(marketKey, m, rawPrice);
            return true;
        }

        if (block.timestamp >= m.settlementPriceRequestedAt + settlementPriceMaxWait) {
            _finalizeSettlementPrice(marketKey, m, rawPrice);
            return true;
        }

        return false;
    }

    function isInTheMoney(bytes32 marketKey) external view returns (bool) {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) revert MarketNotSettled();
        return _isITM(m, m.settlementPrice);
    }

    function claim(bytes32 marketKey, uint256 payoutAmount) external onlyAccount {
        if (payoutAmount == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) revert MarketNotSettled();

        HolderPosition storage hp = holders[marketKey][msg.sender];
        uint256 available =
            hp.payoutBought > hp.payoutClaimed ? (hp.payoutBought - hp.payoutClaimed) : 0;

        if (available < payoutAmount) revert InsufficientHolderPayout();

        bool itm = _isITM(m, m.settlementPrice);
        uint256 actualPayout = itm ? payoutAmount : 0;

        hp.payoutClaimed += payoutAmount;
        m.totalClaimed += payoutAmount;
        marketOpenInterest[marketKey] -= payoutAmount;

        if (hp.payoutBought == hp.payoutClaimed) {
            holderSet[marketKey].remove(msg.sender);
        }

        uint256 remaining = payoutAmount;

        while (remaining > 0) {
            (address writer, uint256 writerAvailable) = _nextWriterWithCapacity(marketKey);
            if (writer == address(0)) revert InsufficientWriterCapacity();

            uint256 take = writerAvailable < remaining ? writerAvailable : remaining;
            WriterPosition storage wp = writers[marketKey][writer];

            wp.payoutAllocated += take;

            if (itm) {
                wp.paidOut += take;
                m.totalPaidOut += take;

                vault.transferETH(writer, msg.sender, take, "binary_margin_option_payout");
            }

            if (wp.payoutWritten == wp.payoutAllocated) {
                writerSet[marketKey].remove(writer);
            }

            remaining -= take;
        }

        emit HolderClaimed(marketKey, msg.sender, payoutAmount, actualPayout);
    }

    function reclaimWriterMargin(bytes32 marketKey) external onlyAccount {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) revert MarketNotSettled();
        if (marketOpenInterest[marketKey] != 0) revert ClaimsOutstanding();

        WriterPosition storage wp = writers[marketKey][msg.sender];
        uint256 reclaimable = wp.lockedMargin > wp.paidOut ? (wp.lockedMargin - wp.paidOut) : 0;

        if (reclaimable == 0) revert NothingToReclaim();

        wp.lockedMargin = wp.paidOut;
        vault.unlockETH(msg.sender, reclaimable);

        emit WriterReclaimed(marketKey, msg.sender, reclaimable);
    }

    function _readStoredOraclePrice(
        MarketConfig storage m
    ) internal view returns (uint256 rawPrice, uint256 priceTimestamp) {
        (rawPrice, , priceTimestamp, ) = priceManager.getOraclePrice(
            m.oracle,
            PriceManager.OracleContext.OPTION_SETTLEMENT
        );
    }

    function _tryRefreshSettlementOracle(address oracle) internal {
        try PriceManager(address(priceManager)).fetchPrice(oracle) {} catch {}
        try PriceManager(address(priceManager)).syncOracleData(oracle) {} catch {}
    }

    function _finalizeSettlementPrice(
        bytes32 marketKey,
        MarketConfig storage m,
        uint256 settlementPriceRaw
    ) internal {
        if (settlementPriceRaw == 0) revert BadSettlementPrice();

        uint256 settlementNorm = _normalizePrice(
            settlementPriceRaw,
            m.oraclePriceDecimals,
            m.paymentTokenDecimals
        );
        if (settlementNorm == 0) revert ZeroSettlementPrice();

        m.settlementPrice = settlementNorm;
        m.settled = true;
        m.settlementPricePending = false;

        emit SettlementPriceSet(marketKey, settlementNorm, _isITM(m, settlementNorm));
    }

    function _nextWriterWithCapacity(
        bytes32 marketKey
    ) internal returns (address writer, uint256 availablePayout) {
        address[] storage q = writerQueue[marketKey];
        uint256 c = writerCursor[marketKey];

        while (c < q.length) {
            address candidate = q[c];
            WriterPosition storage wp = writers[marketKey][candidate];

            if (wp.payoutWritten > wp.payoutAllocated) {
                writerCursor[marketKey] = c;
                return (candidate, wp.payoutWritten - wp.payoutAllocated);
            }

            unchecked {
                ++c;
            }
        }

        writerCursor[marketKey] = q.length;
        return (address(0), 0);
    }

    function _isITM(MarketConfig storage m, uint256 settlementPrice) internal view returns (bool) {
        if (m.optionType == OptionType.Call) {
            return settlementPrice > m.strikePrice;
        } else {
            return settlementPrice < m.strikePrice;
        }
    }

    function _normalizePrice(
        uint256 rawPrice,
        uint8 oracleDec,
        uint8 quoteDec
    ) internal pure returns (uint256) {
        if (rawPrice == 0) return 0;
        if (oracleDec == quoteDec) return rawPrice;
        if (oracleDec < quoteDec) return rawPrice * (10 ** uint256(quoteDec - oracleDec));
        return rawPrice / (10 ** uint256(oracleDec - quoteDec));
    }
}
