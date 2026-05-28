// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AccountRegistry } from "../../accounts/AccountRegistry.sol";
import { SethxVault } from "../../vault/SethxVault.sol";

/**
 * @notice Option position registry and settlement contract.
 * @dev Options use ETH for premiums, strike payments, and put collateral.
 *      Call collateral is the underlying asset token.
 */

contract OptionContract is AccessControl, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.AddressSet;

    error ZeroAddress();
    error Unauthorized();
    error InvalidAccount();
    error InvalidAmount();
    error InvalidExpiry();
    error InvalidStrike();
    error InvalidDivider();
    error InvalidWindow();
    error MarketNotInitialized();
    error NotExerciseWindow();
    error NotReclaimableYet();
    error NotClearableYet();
    error InsufficientPosition();
    error InsufficientUnreservedPosition();
    error NothingToReclaim();
    error WriterPositionReserved();
    error NoWriterPosition();
    error NoHolderPosition();
    error InvalidPaymentToken();
    error MarketMismatch();
    error HolderPositionReserved();
    error NothingToClear();
    error OpenInterestUnderflow();

    // ----- Roles -----
    /// @notice Orderbook is allowed to mint/transfer positions (trading).
    bytes32 public constant ORDERBOOK_ROLE = keccak256("ORDERBOOK_ROLE");

    // ----- Standardization knobs -----
    /// @dev Default exercise window used for newly created markets.
    ///      Existing markets keep the window they were initialized with.
    uint256 public defaultExerciseWindow = 1 days;

    /// @dev Strike granularity control: tick ~= magnitude / strikeDivider. Governor can adjust.
    uint256 public strikeDivider = 50;

    event StrikeDividerUpdated(uint256 oldDivider, uint256 newDivider);
    event DefaultExerciseWindowUpdated(uint256 oldWindow, uint256 newWindow);

    event StrikeNormalized(
        bytes32 indexed marketKey,
        uint256 inputStrike,
        uint256 normalizedStrike,
        uint256 tick
    );

    // ----- Market tracking (global + per-user) -----
    // Global market registry: tracks ALL markets that still have any open interest (OI > 0).
    bytes32[] private allMarkets;
    mapping(bytes32 => uint256) private marketIndexPlus1; // 1-based index into allMarkets
    mapping(bytes32 => uint256) public marketOpenInterest; // outstanding contracts (exercised reduced; expired burned via reclaim)

    // Per-user market registry: markets where the user currently has any holder/writer position left.
    mapping(address => bytes32[]) private userMarkets;
    mapping(address => mapping(bytes32 => uint256)) private userMarketIndexPlus1; // 1-based index into userMarkets[user]

    event MarketAdded(bytes32 indexed marketKey);
    event MarketRemoved(bytes32 indexed marketKey);
    event UserMarketAdded(address indexed user, bytes32 indexed marketKey);
    event UserMarketRemoved(address indexed user, bytes32 indexed marketKey);
    event OpenInterestChanged(bytes32 indexed marketKey, uint256 oldOI, uint256 newOI);

    // ----- Types -----
    enum OptionType {
        Call,
        Put
    }

    uint256 private constant WAD = 1e18;

    struct Position {
        uint256 size; // total position size
        uint256 exercised; // amount already exercised (<= size). After expiry settlement, exercised is set to size.
        uint256 reserved;
    }

    struct OptionMarket {
        // immutable market params (once initialized)
        bool initialized;
        OptionType optionType;
        address assetToken;
        address paymentToken;
        uint256 strikePrice; // quote per 1 asset, scaled to your payment token conventions
        uint256 expiry; // timestamp
        uint256 exerciseWindow; // seconds after expiry during which exercise is allowed
        // aggregates
        uint256 totalSize; // total contracts ever minted for this market (informational)
        uint256 exercisedSize; // total exercised (informational)
        // positions
        mapping(address => Position) holders;
        mapping(address => Position) writers;
        // enumerable participant sets (for UI / bounded cleanup)
        EnumerableSet.AddressSet holderSet;
        EnumerableSet.AddressSet writerSet;
        // writer allocation queue for exercise funding (FIFO)
        address[] writerQueue;
        mapping(address => bool) writerQueued;
        uint256 writerCursor; // points to next writer candidate to consume from
    }

    // ----- State -----
    SethxVault public immutable vault;
    AccountRegistry public immutable accountRegistry;

    mapping(bytes32 => OptionMarket) private markets;

    // ----- Events -----
    event MarketInitialized(
        bytes32 indexed marketKey,
        OptionType optionType,
        address assetToken,
        address paymentToken,
        uint256 strikePrice,
        uint256 expiry,
        uint256 exerciseWindow
    );

    event OptionRegistered(
        bytes32 indexed marketKey,
        address indexed writer,
        address indexed holder,
        uint256 size
    );

    event PositionTransferred(
        bytes32 indexed marketKey,
        address indexed from,
        address indexed to,
        uint256 size,
        bool isWriter
    );

    event Exercised(
        bytes32 indexed marketKey,
        address indexed holder,
        uint256 size,
        uint256 strikePrice
    );

    event WriterConsumed(bytes32 indexed marketKey, address indexed writer, uint256 size);

    event CollateralReclaimed(
        bytes32 indexed marketKey,
        address indexed writer,
        uint256 remainingSize
    );

    event HolderClearedExpired(
        bytes32 indexed marketKey,
        address indexed holder,
        uint256 clearedSize
    );

    // ----- Modifiers -----
    modifier onlyAccount() {
        if (
            !accountRegistry.isAccount(msg.sender) && !accountRegistry.isLendingAccount(msg.sender)
        ) {
            revert InvalidAccount();
        }
        _;
    }

    // ----- Constructor -----
    constructor(address _vault, address _accountRegistry, address admin) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_accountRegistry == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        vault = SethxVault(_vault);
        accountRegistry = AccountRegistry(_accountRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // =========================================================
    //  Admin knobs
    // =========================================================
    function setStrikeDivider(uint256 newDivider) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newDivider < 5 || newDivider > 500) revert InvalidDivider();
        uint256 old = strikeDivider;
        strikeDivider = newDivider;
        emit StrikeDividerUpdated(old, newDivider);
    }

    function setDefaultExerciseWindow(uint256 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWindow == 0) revert InvalidWindow();
        uint256 oldWindow = defaultExerciseWindow;
        defaultExerciseWindow = newWindow;
        emit DefaultExerciseWindowUpdated(oldWindow, newWindow);
    }

    // =========================================================
    //  Market key
    // =========================================================
    function computeMarketKey(
        OptionType optionType,
        address assetToken,
        address paymentToken,
        uint256 strikePrice,
        uint256 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(optionType, assetToken, paymentToken, strikePrice, expiry));
    }

    // =========================================================
    //  Expiry standardization
    // =========================================================
    /// @notice Returns true iff `expiry` is exactly Friday 12:00 UTC.
    function isValidExpiry(uint256 expiry) public pure returns (bool) {
        // weekday: 0=Sunday ... 6=Saturday. Unix epoch 1970-01-01 was a Thursday.
        uint256 day = expiry / 1 days;
        uint256 weekday = (day + 4) % 7;
        if (weekday != 5) return false; // Friday
        return (expiry % 1 days) == 12 hours; // 12:00 UTC
    }

    /// @notice Reverts unless `expiry` is exactly Friday 12:00 UTC.
    function requireValidExpiry(uint256 expiry) public pure {
        if (!isValidExpiry(expiry)) revert InvalidExpiry();
    }

    // =========================================================
    //  Strike standardization
    // =========================================================
    /// @notice Returns the strike tick size implied by `strikeDivider` for a given (scaled) strike input.
    function tickForStrike(uint256 strikeInput) public view returns (uint256) {
        if (strikeInput == 0) revert InvalidStrike();
        uint256 mag = _pow10(_floorLog10(strikeInput));
        uint256 tick = mag / strikeDivider;
        if (tick == 0) tick = 1;
        return tick;
    }

    /// @notice Normalizes `strikeInput` to the nearest valid strike on the tick grid.
    function normalizeStrike(uint256 strikeInput) public view returns (uint256) {
        if (strikeInput == 0) revert InvalidStrike();
        uint256 tick = tickForStrike(strikeInput);
        uint256 half = tick / 2;
        return ((strikeInput + half) / tick) * tick;
    }

    // =========================================================
    //  Market registry views (global + per-user)
    // =========================================================
    function getAllMarketsCount() external view returns (uint256) {
        return allMarkets.length;
    }

    function getAllMarketsPaged(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory out) {
        uint256 n = allMarkets.length;
        if (offset >= n) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;

        out = new bytes32[](end - offset);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = allMarkets[offset + i];
        }
    }

    function getUserMarketsCount(address user) external view returns (uint256) {
        return userMarkets[user].length;
    }

    function getUserMarketsPaged(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory out) {
        uint256 n = userMarkets[user].length;
        if (offset >= n) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;

        out = new bytes32[](end - offset);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = userMarkets[user][offset + i];
        }
    }

    // =========================================================
    //  Market / position views
    // =========================================================
    function marketExists(bytes32 marketKey) external view returns (bool) {
        return markets[marketKey].initialized;
    }

    function getMarket(
        bytes32 marketKey
    )
        external
        view
        returns (
            bool initialized,
            OptionType optionType,
            address assetToken,
            address paymentToken,
            uint256 strikePrice,
            uint256 expiry,
            uint256 exerciseWindow,
            uint256 totalSize,
            uint256 exercisedSize,
            uint256 writerCursor
        )
    {
        OptionMarket storage m = markets[marketKey];
        return (
            m.initialized,
            m.optionType,
            m.assetToken,
            m.paymentToken,
            m.strikePrice,
            m.expiry,
            m.exerciseWindow,
            m.totalSize,
            m.exercisedSize,
            m.writerCursor
        );
    }

    function getUserPosition(
        bytes32 marketKey,
        address account
    ) external view returns (uint256 writerSize, uint256 holderSize, uint256 holderExercised) {
        OptionMarket storage m = markets[marketKey];
        Position storage w = m.writers[account];
        Position storage h = m.holders[account];
        return (w.size, h.size, h.exercised);
    }

    // =========================================================
    //  Trading hooks (OrderBook only)
    // =========================================================

    /**
     * @notice Called by the orderbook when a writer and holder are matched.
     * @dev The orderbook is responsible for premium transfer and collateral locking.
     */
    function registerNewOption(
        OptionType optionType,
        address assetToken,
        address paymentToken,
        uint256 strikePriceInput,
        uint256 expiry,
        address writer,
        address holder,
        uint256 size
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (assetToken == address(0)) revert ZeroAddress();
        if (size == 0) revert InvalidAmount();
        if (paymentToken != address(0)) revert InvalidPaymentToken();
        if (writer == address(0) || holder == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        requireValidExpiry(expiry);

        uint256 strikePrice = normalizeStrike(strikePriceInput);
        uint256 tick = tickForStrike(strikePriceInput);

        bytes32 marketKey = computeMarketKey(
            optionType,
            assetToken,
            paymentToken,
            strikePrice,
            expiry
        );

        OptionMarket storage m = markets[marketKey];

        if (!m.initialized) {
            m.initialized = true;
            m.optionType = optionType;
            m.assetToken = assetToken;
            m.paymentToken = paymentToken;
            m.strikePrice = strikePrice;
            m.expiry = expiry;
            m.exerciseWindow = defaultExerciseWindow;

            emit MarketInitialized(
                marketKey,
                optionType,
                assetToken,
                paymentToken,
                strikePrice,
                expiry,
                defaultExerciseWindow
            );
        } else {
            // enforce consistent market params
            if (
                m.optionType != optionType ||
                m.assetToken != assetToken ||
                m.paymentToken != paymentToken ||
                m.strikePrice != strikePrice ||
                m.expiry != expiry
            ) {
                revert MarketMismatch();
            }
        }

        // informational event for indexers / UI
        emit StrikeNormalized(marketKey, strikePriceInput, strikePrice, tick);

        // ---- Open interest + global registry ----
        _addMarketIfNeeded(marketKey);
        _changeOpenInterest(marketKey, int256(size)); // +size on mint

        // aggregates
        m.totalSize += size;

        // holder position
        m.holders[holder].size += size;
        m.holderSet.add(holder);

        // writer position
        m.writers[writer].size += size;
        m.writerSet.add(writer);

        // per-user registry
        _addUserMarketIfNeeded(holder, marketKey);
        _addUserMarketIfNeeded(writer, marketKey);

        // writer queue (FIFO exercise allocation)
        if (!m.writerQueued[writer]) {
            m.writerQueued[writer] = true;
            m.writerQueue.push(writer);
        }

        emit OptionRegistered(marketKey, writer, holder, size);
    }

    /**
     * @notice Transfer unexercised position between accounts (secondary trading inside platform).
     * @dev Only unexercised size can be transferred. Exercised history stays with the original account.
     */
    function transferPosition(
        bytes32 marketKey,
        address from,
        address to,
        uint256 size,
        bool isWriter
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (from == to) revert InvalidAccount();

        OptionMarket storage m = markets[marketKey];

        if (!m.initialized) revert MarketNotInitialized();

        if (isWriter) {
            Position storage fp = m.writers[from];
            if (fp.size < fp.exercised + fp.reserved + size) {
                revert InsufficientUnreservedPosition();
            }

            fp.size -= size;
            m.writers[to].size += size;

            m.writerSet.add(to);
            if (fp.size == fp.exercised) {
                m.writerSet.remove(from);
            }

            if (!m.writerQueued[to]) {
                m.writerQueued[to] = true;
                m.writerQueue.push(to);
            }
        } else {
            Position storage fp = m.holders[from];
            if (fp.size < fp.exercised + fp.reserved + size) {
                revert InsufficientUnreservedPosition();
            }
            fp.size -= size;
            m.holders[to].size += size;

            m.holderSet.add(to);
            if (fp.size == fp.exercised) {
                m.holderSet.remove(from);
            }
        }

        // Update per-user market registry (add/remove depending on remaining position)
        _refreshUserMarket(from, marketKey);
        _refreshUserMarket(to, marketKey);

        emit PositionTransferred(marketKey, from, to, size, isWriter);
    }

    function reservePosition(
        bytes32 marketKey,
        address owner,
        uint256 size,
        bool isWriter
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (owner == address(0)) revert ZeroAddress();

        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        Position storage p = isWriter ? m.writers[owner] : m.holders[owner];

        uint256 available = p.size - p.exercised - p.reserved;
        if (available < size) revert InsufficientUnreservedPosition();

        p.reserved += size;
    }

    function releasePositionReservation(
        bytes32 marketKey,
        address owner,
        uint256 size,
        bool isWriter
    ) external onlyRole(ORDERBOOK_ROLE) {
        if (size == 0) revert InvalidAmount();
        if (owner == address(0)) revert ZeroAddress();

        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        Position storage p = isWriter ? m.writers[owner] : m.holders[owner];
        if (p.reserved < size) revert InsufficientUnreservedPosition();

        p.reserved -= size;
    }

    // =========================================================
    //  Lifecycle (Accounts only): exercise + reclaim + clear
    // =========================================================

    /**
     * @notice Exercise a holder position during the exercise window.
     * @dev This contract assumes the vault can:
     *      - lockERC20/lockETH for msg.sender (account) to escrow strike/delivery
     *      - transferToken/transferETH from locked -> available
     */
    function exercise(bytes32 marketKey, uint256 size) external onlyAccount nonReentrant {
        if (size == 0) revert InvalidAmount();

        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();

        // Exercisable AFTER expiry within a window.
        if (block.timestamp < m.expiry || block.timestamp > m.expiry + m.exerciseWindow) {
            revert NotExerciseWindow();
        }

        Position storage holderPos = m.holders[msg.sender];
        uint256 availableToExercise = holderPos.size - holderPos.exercised - holderPos.reserved;
        if (availableToExercise < size) revert InsufficientUnreservedPosition();

        // Update holder state first
        holderPos.exercised += size;
        m.exercisedSize += size;

        // Open interest decreases by exercised amount
        _changeOpenInterest(marketKey, -int256(size));

        // Prepare holder escrow (lock) for the leg they must deliver
        if (m.optionType == OptionType.Call) {
            uint256 quoteAmount = (size * m.strikePrice) / WAD;
            vault.lockETH(msg.sender, quoteAmount);
        } else {
            // Put: holder delivers asset
            _lockAssetOrETH(msg.sender, m.assetToken, size);
        }

        // Allocate writer side FIFO and settle legs
        uint256 remaining = size;
        while (remaining > 0) {
            (address writer, uint256 writerAvail) = _nextWriterWithCapacity(marketKey);
            if (writer == address(0)) revert InsufficientPosition();

            uint256 take = writerAvail < remaining ? writerAvail : remaining;

            // Mark writer exercised
            Position storage writerPos = m.writers[writer];
            writerPos.exercised += take;

            // Settlement transfers (locked -> available)
            if (m.optionType == OptionType.Call) {
                // writer delivers asset, holder pays quote
                _transferAssetOrETH(
                    writer,
                    msg.sender,
                    m.assetToken,
                    take,
                    "CALL exercise: asset delivery"
                );

                uint256 quotePay = (take * m.strikePrice) / WAD;
                vault.transferETH(msg.sender, writer, quotePay, "CALL exercise: strike payment");
            } else {
                // PUT: writer pays quote, holder delivers asset
                uint256 quotePay = (take * m.strikePrice) / WAD;
                vault.transferETH(writer, msg.sender, quotePay, "PUT exercise: strike payment");

                _transferAssetOrETH(
                    msg.sender,
                    writer,
                    m.assetToken,
                    take,
                    "PUT exercise: asset delivery"
                );
            }

            emit WriterConsumed(marketKey, writer, take);

            // Cleanup sets (bounded to touched addresses)
            if (writerPos.size == writerPos.exercised) {
                m.writerSet.remove(writer);
            }

            // Update per-user registry for this writer if they got fully consumed
            _refreshUserMarket(writer, marketKey);

            remaining -= take;
        }

        // Holder cleanup if fully exercised
        if (holderPos.size == holderPos.exercised) {
            m.holderSet.remove(msg.sender);
        }
        _refreshUserMarket(msg.sender, marketKey);

        emit Exercised(marketKey, msg.sender, size, m.strikePrice);
    }

    /**
     * @notice Reclaim remaining collateral after the exercise window closes.
     * @dev This also BURNS any remaining unexercised open interest for the writer (so markets can be removed).
     */
    function reclaimExpired(bytes32 marketKey) external onlyAccount nonReentrant {
        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (block.timestamp <= m.expiry + m.exerciseWindow) revert NotReclaimableYet();

        Position storage writerPos = m.writers[msg.sender];
        if (writerPos.size == 0) revert NoWriterPosition();
        if (writerPos.reserved != 0) revert WriterPositionReserved();

        uint256 remainingSize = writerPos.size - writerPos.exercised;
        if (remainingSize == 0) revert NothingToReclaim();

        // Unlock remaining writer collateral
        if (m.optionType == OptionType.Call) {
            // call writers collateralized in asset
            _unlockAssetOrETH(msg.sender, m.assetToken, remainingSize);
        } else {
            // put writers collateralized in quote = remainingSize * strike
            uint256 quoteAmount = (remainingSize * m.strikePrice) / WAD;
            vault.unlockETH(msg.sender, quoteAmount);
        }

        // Burn the remaining (unexercised) contracts from open interest.
        // These contracts are now expired worthless, so OI must be reduced.
        _changeOpenInterest(marketKey, -int256(remainingSize));

        // Mark fully reclaimed by setting exercised=size (so remaining becomes 0)
        writerPos.exercised = writerPos.size;

        // Cleanup writer set + per-user registry
        m.writerSet.remove(msg.sender);
        _refreshUserMarket(msg.sender, marketKey);

        emit CollateralReclaimed(marketKey, msg.sender, remainingSize);
    }

    /**
     * @notice Optional cleanup for holders after expiry+window: clears expired worthless holder remainder
     *         so the UI "active positions" list stays clean.
     * @dev Does NOT change open interest (that is burned on writer reclaim).
     */
    function clearExpiredHolder(bytes32 marketKey) external onlyAccount nonReentrant {
        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) revert MarketNotInitialized();
        if (block.timestamp <= m.expiry + m.exerciseWindow) revert NotClearableYet();

        Position storage hp = m.holders[msg.sender];
        if (hp.size == 0) revert NoHolderPosition();
        if (hp.reserved != 0) revert HolderPositionReserved();

        uint256 remaining = hp.size - hp.exercised;
        if (remaining == 0) revert NothingToClear();

        hp.exercised = hp.size;

        // Cleanup holder set + per-user registry
        m.holderSet.remove(msg.sender);
        _refreshUserMarket(msg.sender, marketKey);

        emit HolderClearedExpired(marketKey, msg.sender, remaining);
    }

    // =========================================================
    //  Internal helpers
    // =========================================================
    function _nextWriterWithCapacity(
        bytes32 marketKey
    ) internal returns (address writer, uint256 capacity) {
        OptionMarket storage m = markets[marketKey];

        uint256 n = m.writerQueue.length;
        uint256 i = m.writerCursor;

        while (i < n) {
            address w = m.writerQueue[i];
            Position storage wp = m.writers[w];
            uint256 avail = wp.size - wp.exercised;
            if (avail > 0) {
                // keep cursor here for next iteration (same writer might still have capacity)
                m.writerCursor = i;
                return (w, avail);
            }
            i++;
        }

        m.writerCursor = n;
        return (address(0), 0);
    }

    function _lockAssetOrETH(address account, address assetToken, uint256 amount) internal {
        if (assetToken == address(0)) vault.lockETH(account, amount);
        else vault.lockERC20(account, assetToken, amount);
    }

    function _unlockAssetOrETH(address account, address assetToken, uint256 amount) internal {
        if (assetToken == address(0)) vault.unlockETH(account, amount);
        else vault.unlockERC20(account, assetToken, amount);
    }

    function _transferAssetOrETH(
        address from,
        address to,
        address assetToken,
        uint256 amount,
        string memory reason
    ) internal {
        if (assetToken == address(0)) vault.transferETH(from, to, amount, reason);
        else vault.transferToken(from, to, assetToken, amount, reason);
    }

    // ----- Global market registry -----
    function _addMarketIfNeeded(bytes32 marketKey) internal {
        if (marketIndexPlus1[marketKey] != 0) return;
        allMarkets.push(marketKey);
        marketIndexPlus1[marketKey] = allMarkets.length; // 1-based
        emit MarketAdded(marketKey);
    }

    function _removeMarket(bytes32 marketKey) internal {
        uint256 idx1 = marketIndexPlus1[marketKey];
        if (idx1 == 0) return;

        uint256 idx = idx1 - 1;
        uint256 lastIdx = allMarkets.length - 1;

        if (idx != lastIdx) {
            bytes32 lastKey = allMarkets[lastIdx];
            allMarkets[idx] = lastKey;
            marketIndexPlus1[lastKey] = idx + 1;
        }

        allMarkets.pop();
        marketIndexPlus1[marketKey] = 0;

        emit MarketRemoved(marketKey);
    }

    function _changeOpenInterest(bytes32 marketKey, int256 delta) internal {
        uint256 oldOI = marketOpenInterest[marketKey];

        if (delta > 0) {
            uint256 add = uint256(delta);
            uint256 newOI = oldOI + add;
            marketOpenInterest[marketKey] = newOI;
            emit OpenInterestChanged(marketKey, oldOI, newOI);
            return;
        }

        uint256 sub = uint256(-delta);
        if (oldOI < sub) revert OpenInterestUnderflow();
        uint256 newOI2 = oldOI - sub;
        marketOpenInterest[marketKey] = newOI2;
        emit OpenInterestChanged(marketKey, oldOI, newOI2);

        if (newOI2 == 0) {
            _removeMarket(marketKey);
        }
    }

    // ----- Per-user market registry -----
    function _addUserMarketIfNeeded(address user, bytes32 marketKey) internal {
        if (userMarketIndexPlus1[user][marketKey] != 0) return;
        userMarkets[user].push(marketKey);
        userMarketIndexPlus1[user][marketKey] = userMarkets[user].length; // 1-based
        emit UserMarketAdded(user, marketKey);
    }

    function _removeUserMarket(address user, bytes32 marketKey) internal {
        uint256 idx1 = userMarketIndexPlus1[user][marketKey];
        if (idx1 == 0) return;

        uint256 idx = idx1 - 1;
        uint256 lastIdx = userMarkets[user].length - 1;

        if (idx != lastIdx) {
            bytes32 lastKey = userMarkets[user][lastIdx];
            userMarkets[user][idx] = lastKey;
            userMarketIndexPlus1[user][lastKey] = idx + 1;
        }

        userMarkets[user].pop();
        userMarketIndexPlus1[user][marketKey] = 0;

        emit UserMarketRemoved(user, marketKey);
    }

    function _refreshUserMarket(address user, bytes32 marketKey) internal {
        OptionMarket storage m = markets[marketKey];
        if (!m.initialized) {
            _removeUserMarket(user, marketKey);
            return;
        }

        Position storage w = m.writers[user];
        Position storage h = m.holders[user];

        uint256 wRem = w.size > w.exercised ? (w.size - w.exercised) : 0;
        uint256 hRem = h.size > h.exercised ? (h.size - h.exercised) : 0;

        if (wRem > 0 || hRem > 0) _addUserMarketIfNeeded(user, marketKey);
        else _removeUserMarket(user, marketKey);
    }

    // ----- Math helpers -----
    function _floorLog10(uint256 x) internal pure returns (uint256 r) {
        // x > 0 assumed by callers
        while (x >= 10) {
            x /= 10;
            unchecked {
                r++;
            }
        }
    }

    function _pow10(uint256 exp) internal pure returns (uint256 r) {
        r = 1;
        for (uint256 i = 0; i < exp; ) {
            r *= 10;
            unchecked {
                i++;
            }
        }
    }
}
