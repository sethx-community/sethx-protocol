// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { PriceManager } from "../../oracle/PriceManager.sol";
import { IPriceOracle } from "../../oracle/interfaces/IPriceOracle.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { AccountRegistry } from "../../accounts/AccountRegistry.sol";

/**
 * @notice Capped linear option ledger settled in quote token only.
 *
 * Product summary
 * - Similar lifecycle to options: writer/holder positions, secondary transfers, expiry settlement.
 * - Governor approves oracle usage in PriceManager and allowed collateral percentages.
 * - Anyone can create a Friday-noon option market using an approved oracle/config.
 * - Collateral is locked margin in quote token and is also the maximum payout.
 * - Payout is oracle-price-vs-strike linear intrinsic, capped by locked margin.
 *
 * Conventions
 * - `size` uses 1e18 precision, same as the existing option contracts.
 * - `strikePrice` and settlement price are normalized into quote-token decimals.
 * - `size` is the only exposure scaler; there is no per-market multiplier.
 */
contract MarginOptionContract is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");
    uint256 public constant WAD = 1e18;

    uint256 public settlementPriceMaxWait = 1 hours;

    error ZeroAddress();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidStrike();
    error InvalidIncrement();
    error InvalidStrikeDivider();
    error InvalidExpiry();
    error InvalidCollateralBps();
    error InvalidOracle();
    error PriceManagerNotSet();
    error MarketAlreadyExists();
    error MarketNotInitialized();
    error MarketIsClosed();
    error MarketExpired();
    error MarketAlreadySettled();
    error MarketNotSettled();
    error MarketUnavailable();
    error InsufficientHolderSize();
    error InsufficientWriterSize();
    error InsufficientWriterMargin();
    error InsufficientReservedWriterSize();
    error InsufficientReservedHolderSize();
    error InsufficientClaimable();
    error InsufficientWriterCapacity();
    error NothingToReclaim();
    error ClaimsOutstanding();
    error WriterPositionReserved();
    error IndexOutOfRange();
    error BadSettlementPrice();
    error ZeroSettlementPrice();
    error InvalidSettlementPriceMaxWait();

    enum OptionType {
        Call,
        Put
    }

    struct HolderPosition {
        uint256 size;
        uint256 claimed;
        uint256 reserved;
    }

    struct WriterPosition {
        uint256 size;
        uint256 allocated; // holder-claim size already assigned to this writer
        uint256 lockedMargin;
        uint256 paidOut;
        uint256 reserved;
    }

    struct MarketConfig {
        bool initialized;
        bool active;
        bool settled;
        OptionType optionType;
        string ticker;
        address oracle;
        address paymentToken; // always address(0), ETH
        uint8 oraclePriceDecimals;
        uint8 paymentTokenDecimals; // always 18
        uint256 strikePrice;
        uint256 strikeIncrement;
        uint256 expiry;
        uint256 collateralBps;
        uint256 settlementPrice;
        bool settlementPricePending;
        uint256 settlementPriceRequestedAt;
        uint256 totalSize;
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

    mapping(uint256 => bool) public approvedCollateralBps;


    event MarketCreated(
        bytes32 indexed marketKey,
        OptionType optionType,
        address indexed oracle,
        address indexed paymentToken,
        uint256 normalizedStrike,
        uint256 expiry,
        uint256 collateralBps,
        uint256 strikeIncrement,
        string ticker
    );
    event MarketOpened(bytes32 indexed marketKey);
    event MarketClosed(bytes32 indexed marketKey);
    event SettlementPriceSet(
        bytes32 indexed marketKey,
        uint256 settlementPrice,
        uint256 payoutPerUnit
    );
    event SettlementPricePending(
        bytes32 indexed marketKey,
        uint256 requestedAt,
        uint256 expiry,
        uint256 lastPriceTimestamp
    );
    event SettlementPriceMaxWaitUpdated(uint256 oldWait, uint256 newWait);
    event StrikeDividerUpdated(uint256 oldDivider, uint256 newDivider);
    event CollateralBpsApprovalSet(uint256 indexed collateralBps, bool approved);
    event MarginOptionRegistered(
        bytes32 indexed marketKey,
        address indexed writer,
        address indexed holder,
        uint256 size,
        uint256 lockedMargin
    );
    event HolderPositionTransferred(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed to,
        uint256 size
    );
    event WriterPositionTransferred(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed to,
        uint256 size,
        uint256 lockedMargin
    );
    event HolderClaimed(
        bytes32 indexed marketKey,
        address indexed holder,
        uint256 size,
        uint256 payoutAmount
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

    function setApprovedCollateralBps(uint256 collateralBps, bool approved) external onlyRole(GOVERNOR_ROLE) {
        if (collateralBps == 0 || collateralBps > 10_000) revert InvalidCollateralBps();
        approvedCollateralBps[collateralBps] = approved;
        emit CollateralBpsApprovalSet(collateralBps, approved);
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
        uint256 expiry,
        uint256 collateralBps
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(optionType, oracle, paymentToken, strikePrice, expiry, collateralBps)
            );
    }

    /// @dev Strike granularity control: tick ~= magnitude / strikeDivider. Governor can adjust.
    uint256 public strikeDivider = 50;

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

    function reserveWriterPosition(
        bytes32 marketKey,
        address writer,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        WriterPosition storage wp = writers[marketKey][writer];

        uint256 available = wp.size - wp.allocated - wp.reserved;
        if (available < size) revert InsufficientWriterSize();

        wp.reserved += size;
    }

    function releaseWriterPositionReservation(
        bytes32 marketKey,
        address writer,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (!markets[marketKey].initialized) revert MarketNotInitialized();

        WriterPosition storage wp = writers[marketKey][writer];
        if (wp.reserved < size) revert InsufficientReservedWriterSize();

        wp.reserved -= size;
    }

    function reserveHolderPosition(
        bytes32 marketKey,
        address holder,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        HolderPosition storage hp = holders[marketKey][holder];

        uint256 available = hp.size - hp.claimed - hp.reserved;
        if (available < size) revert InsufficientHolderSize();

        hp.reserved += size;
    }

    function releaseHolderPositionReservation(
        bytes32 marketKey,
        address holder,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        HolderPosition storage hp = holders[marketKey][holder];
        if (hp.reserved < size) revert InsufficientReservedHolderSize();

        hp.reserved -= size;
    }

    function previewMarketKey(
        OptionType optionType,
        address oracle,
        uint256 strikePriceInput,
        uint256 expiry,
        uint256 collateralBps
    ) public view returns (bytes32 marketKey, uint256 normalizedStrike, uint256 normalizedStrikeIncrement) {
        uint8 paymentDec = 18;
        uint8 oracleDec = IPriceOracle(oracle).decimals();
        uint256 strikeInputNorm = _normalizePrice(strikePriceInput, oracleDec, paymentDec);
        normalizedStrike = normalizeStrike(strikeInputNorm);
        normalizedStrikeIncrement = tickForStrike(strikeInputNorm);
        marketKey = computeMarketKey(optionType, oracle, address(0), normalizedStrike, expiry, collateralBps);
    }

    function createMarket(
        string calldata ticker,
        OptionType optionType,
        address oracle,
        uint256 strikePriceInput,
        uint256 expiry,
        uint256 collateralBps
    ) public returns (bytes32 marketKey) {
        if (expiry <= block.timestamp) revert InvalidExpiry();
        requireValidExpiry(expiry);
        if (collateralBps == 0 || collateralBps > 10_000) {
            revert InvalidCollateralBps();
        }
        if (!approvedCollateralBps[collateralBps]) revert InvalidCollateralBps();
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

        uint256 strikeInputNorm = _normalizePrice(strikePriceInput, oracleDec, paymentDec);
        uint256 strikeIncrementNorm = tickForStrike(strikeInputNorm);
        uint256 strikePrice = normalizeStrike(strikeInputNorm);

        marketKey = computeMarketKey(
            optionType,
            oracle,
            paymentToken,
            strikePrice,
            expiry,
            collateralBps
        );
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
            collateralBps: collateralBps,
            settlementPrice: 0,
            settlementPricePending: false,
            settlementPriceRequestedAt: 0,
            totalSize: 0,
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
            collateralBps,
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

    function getRequiredMargin(bytes32 marketKey, uint256 size) public view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        return _requiredMargin(m, size);
    }

    function getPayoutPerUnit(bytes32 marketKey) public view returns (uint256) {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) return 0;
        return _payoutPerUnit(m, m.settlementPrice);
    }

    function registerNewPosition(
        bytes32 marketKey,
        address writer,
        address holder,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (writer == address(0) || holder == address(0)) revert ZeroAddress();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.active) revert MarketIsClosed();
        if (block.timestamp >= m.expiry) revert MarketExpired();

        uint256 marginAmount = _requiredMargin(m, size);

        holders[marketKey][holder].size += size;
        writers[marketKey][writer].size += size;
        writers[marketKey][writer].lockedMargin += marginAmount;

        holderSet[marketKey].add(holder);
        writerSet[marketKey].add(writer);

        if (!writerQueued[marketKey][writer]) {
            writerQueued[marketKey][writer] = true;
            writerQueue[marketKey].push(writer);
        }

        m.totalSize += size;
        m.totalWriterMargin += marginAmount;
        marketOpenInterest[marketKey] += size;

        emit MarginOptionRegistered(marketKey, writer, holder, size, marginAmount);
    }

    function transferHolderPosition(
        bytes32 marketKey,
        address from,
        address to,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (from == address(0) || to == address(0) || from == to) {
            revert InvalidAccount();
        }

        HolderPosition storage hpFrom = holders[marketKey][from];
        HolderPosition storage hpTo = holders[marketKey][to];
        uint256 available = hpFrom.size - hpFrom.claimed - hpFrom.reserved;
        if (available < size) revert InsufficientHolderSize();
        hpFrom.size -= size;
        hpTo.size += size;

        if (hpFrom.size == hpFrom.claimed) holderSet[marketKey].remove(from);
        holderSet[marketKey].add(to);

        emit HolderPositionTransferred(marketKey, from, to, size);
    }

    function transferWriterPosition(
        bytes32 marketKey,
        address from,
        address to,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (from == address(0) || to == address(0) || from == to) {
            revert InvalidAccount();
        }

        WriterPosition storage wpFrom = writers[marketKey][from];
        WriterPosition storage wpTo = writers[marketKey][to];
        uint256 available = wpFrom.size - wpFrom.allocated - wpFrom.reserved;
        if (available < size) revert InsufficientWriterSize();

        uint256 marginAmount = getRequiredMargin(marketKey, size);
        if (wpFrom.lockedMargin < wpFrom.paidOut + marginAmount) {
            revert InsufficientWriterMargin();
        }

        wpFrom.size -= size;
        wpFrom.lockedMargin -= marginAmount;

        wpTo.size += size;
        wpTo.lockedMargin += marginAmount;

        if (wpFrom.size == wpFrom.allocated) writerSet[marketKey].remove(from);
        writerSet[marketKey].add(to);
        if (!writerQueued[marketKey][to]) {
            writerQueued[marketKey][to] = true;
            writerQueue[marketKey].push(to);
        }

        emit WriterPositionTransferred(marketKey, from, to, size, marginAmount);
    }

    /**
     * @notice Permissionless oracle-based settlement.
     * @dev Settlement prefers the first PriceManager-stored oracle price whose timestamp is
     *      at or after expiry. If no such price is available yet, the first caller starts a
     *      bounded pending window and asks PriceManager to fetch/sync. Later callers can
     *      finalize once a post-expiry price is stored. After the max wait, the last known
     *      stored price is used so settlement cannot be blocked forever by an oracle fetch
     *      failure or delayed updater.
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

    function claim(bytes32 marketKey, uint256 size) external onlyAccount {
        if (size == 0) revert InvalidAmount();

        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) revert MarketNotSettled();

        HolderPosition storage hp = holders[marketKey][msg.sender];
        uint256 available = hp.size - hp.claimed - hp.reserved;
        if (available < size) revert InsufficientClaimable();

        uint256 payoutPerUnit = _payoutPerUnit(m, m.settlementPrice);
        uint256 payoutAmount = (size * payoutPerUnit) / WAD;

        hp.claimed += size;
        m.totalClaimed += size;
        marketOpenInterest[marketKey] -= size;

        if (hp.size == hp.claimed) {
            holderSet[marketKey].remove(msg.sender);
        }

        if (payoutAmount > 0) {
            uint256 remaining = size;
            while (remaining > 0) {
                (address writer, uint256 writerAvailable) = _nextWriterWithClaimCapacity(marketKey);
                if (writer == address(0)) revert InsufficientWriterCapacity();

                uint256 take = writerAvailable < remaining ? writerAvailable : remaining;
                uint256 writerPay = (take * payoutPerUnit) / WAD;

                WriterPosition storage wp = writers[marketKey][writer];
                wp.allocated += take;
                wp.paidOut += writerPay;
                m.totalPaidOut += writerPay;

                vault.transferETH(writer, msg.sender, writerPay, "margin_option_payout");

                if (wp.size == wp.allocated) {
                    writerSet[marketKey].remove(writer);
                }

                remaining -= take;
            }
        } else {
            uint256 remaining = size;
            while (remaining > 0) {
                (address writer, uint256 writerAvailable) = _nextWriterWithClaimCapacity(marketKey);
                if (writer == address(0)) revert InsufficientWriterCapacity();
                uint256 take = writerAvailable < remaining ? writerAvailable : remaining;
                writers[marketKey][writer].allocated += take;
                if (writers[marketKey][writer].size == writers[marketKey][writer].allocated) {
                    writerSet[marketKey].remove(writer);
                }
                remaining -= take;
            }
        }

        emit HolderClaimed(marketKey, msg.sender, size, payoutAmount);
    }

    function reclaimWriterMargin(bytes32 marketKey) external onlyAccount {
        MarketConfig storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (!m.settled) revert MarketNotSettled();
        if (marketOpenInterest[marketKey] != 0) revert ClaimsOutstanding();

        WriterPosition storage wp = writers[marketKey][msg.sender];
        if (wp.reserved != 0) revert WriterPositionReserved();
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

        emit SettlementPriceSet(marketKey, settlementNorm, _payoutPerUnit(m, settlementNorm));
    }

    function _nextWriterWithClaimCapacity(
        bytes32 marketKey
    ) internal returns (address writer, uint256 availableSize) {
        address[] storage q = writerQueue[marketKey];
        uint256 c = writerCursor[marketKey];

        while (c < q.length) {
            address candidate = q[c];
            WriterPosition storage wp = writers[marketKey][candidate];

            uint256 available = wp.size > wp.allocated ? (wp.size - wp.allocated) : 0;

            if (available > 0) {
                writerCursor[marketKey] = c;
                return (candidate, available);
            }

            unchecked {
                ++c;
            }
        }

        writerCursor[marketKey] = q.length;
        return (address(0), 0);
    }

    function _requiredMargin(MarketConfig storage m, uint256 size) internal view returns (uint256) {
        // size * strike * collateralBps / (WAD * 10_000)
        uint256 grossNotional = (size * m.strikePrice) / WAD;
        return (grossNotional * m.collateralBps) / 10_000;
    }

    function _payoutPerUnit(
        MarketConfig storage m,
        uint256 settlementPrice
    ) internal view returns (uint256) {
        uint256 intrinsic;
        if (m.optionType == OptionType.Call) {
            intrinsic = settlementPrice > m.strikePrice ? (settlementPrice - m.strikePrice) : 0;
        } else {
            intrinsic = settlementPrice < m.strikePrice ? (m.strikePrice - settlementPrice) : 0;
        }

        uint256 cap = _requiredMargin(m, WAD);
        return intrinsic < cap ? intrinsic : cap;
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
