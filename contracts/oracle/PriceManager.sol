// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

contract PriceManager is AccessControl {
    using Math for uint256;

    error ZeroAddress();
    error Unauthorized();
    error InvalidTimeout();
    error OracleNotApproved();
    error OracleNotApprovedForContext();
    error OracleNotUsableForContext();
    error TokenNotAllowedForContext();
    error MissingPrice();
    error FeeConversionOracleUnavailable();

    uint256 public constant WAD = 1e18;

    modifier onlyGovernance() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    enum OracleStatus {
        OK,
        DEGRADED,
        FROZEN,
        PENDING,
        STALE
    }

    enum OracleContext {
        GENERAL,
        TRADE_VALUE,
        FUTURE_SETTLEMENT,
        COLLATERAL_EVAL,
        OPTION_SETTLEMENT,
        FEE_CONVERSION
    }

    struct OracleData {
        bool approved;
        uint256 lastPrice;
        uint256 lastTimestamp;
        OracleStatus status;
        uint256 firstRecordedDay;
    }

    struct OracleSnapshot {
        uint256 price;
        uint256 timestamp;
        OracleStatus status;
    }

    struct OracleMetadata {
        address token;
        string label;
        string description;
    }

    uint256 public staleTimeout;

    mapping(address => OracleData) public oracles;
    mapping(address => OracleMetadata) public oracleMetadata;
    mapping(address => mapping(OracleContext => bool)) public contextApprovals;

    address[] public approvedOracles;
    mapping(address => uint256) private oracleIndexPlus1;

    mapping(address => address[]) private tokenToOracles;
    mapping(address => mapping(address => bool)) private tokenOracleListed;

    mapping(address => mapping(uint256 => OracleSnapshot)) public dailySnapshots;

    mapping(address => mapping(OracleContext => bool)) public tokenAllowedForContext;
    mapping(address => mapping(OracleContext => address[])) private tokenContextOracles;

    event TokenAllowedForContextSet(
        address indexed token,
        OracleContext indexed context,
        bool allowed
    );

    event TokenContextOracleRegistered(
        address indexed token,
        OracleContext indexed context,
        address indexed oracle
    );

    event TokenContextOracleRemoved(
        address indexed token,
        OracleContext indexed context,
        address indexed oracle
    );

    event OracleSynced(address indexed oracle, uint256 price, string status, uint256 timestamp);
    event OracleApproved(address indexed oracle, uint256 timestamp);
    event OracleRemoved(address indexed oracle, uint256 timestamp);
    event OracleSyncFailed(address indexed oracle);
    event FirstPriceOfDayRecorded(address indexed oracle, uint256 day, uint256 price);

    event OracleContextApproved(address indexed oracle, OracleContext indexed context);
    event OracleContextRevoked(address indexed oracle, OracleContext indexed context);

    event OracleMetadataSet(
        address indexed oracle,
        address indexed token,
        string label,
        string description
    );

    event StaleTimeoutSet(uint256 newTimeout);

    constructor(address admin, uint256 initialStaleTimeout) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialStaleTimeout < 5 minutes) revert InvalidTimeout();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        staleTimeout = initialStaleTimeout;
        emit StaleTimeoutSet(staleTimeout);
    }

    // -------------------------------------------------------------------------
    // Governance
    // -------------------------------------------------------------------------

    function setStaleTimeout(uint256 newTimeout) external onlyGovernance {
        if (newTimeout < 5 minutes) revert InvalidTimeout();
        staleTimeout = newTimeout;
        emit StaleTimeoutSet(newTimeout);
    }

    function approveOracle(address oracle) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();

        OracleData storage o = oracles[oracle];

        if (!o.approved) {
            o.approved = true;
            o.status = OracleStatus.OK;
            o.firstRecordedDay = block.timestamp / 1 days;

            _addOracleToList(oracle);
        }

        emit OracleApproved(oracle, block.timestamp);
    }

    function removeOracle(address oracle) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        contextApprovals[oracle][OracleContext.GENERAL] = false;
        contextApprovals[oracle][OracleContext.TRADE_VALUE] = false;
        contextApprovals[oracle][OracleContext.FUTURE_SETTLEMENT] = false;
        contextApprovals[oracle][OracleContext.COLLATERAL_EVAL] = false;
        contextApprovals[oracle][OracleContext.OPTION_SETTLEMENT] = false;
        contextApprovals[oracle][OracleContext.FEE_CONVERSION] = false;

        oracles[oracle].approved = false;
        oracles[oracle].status = OracleStatus.DEGRADED;

        address token = oracleMetadata[oracle].token;

        if (token != address(0)) {
            _removeOracleFromTokenList(token, oracle);
        }

        _removeOracleFromTokenContextList(token, OracleContext.GENERAL, oracle);
        _removeOracleFromTokenContextList(token, OracleContext.TRADE_VALUE, oracle);
        _removeOracleFromTokenContextList(token, OracleContext.FUTURE_SETTLEMENT, oracle);
        _removeOracleFromTokenContextList(token, OracleContext.COLLATERAL_EVAL, oracle);
        _removeOracleFromTokenContextList(token, OracleContext.OPTION_SETTLEMENT, oracle);
        _removeOracleFromTokenContextList(token, OracleContext.FEE_CONVERSION, oracle);

        delete oracleMetadata[oracle];

        _removeOracleFromList(oracle);

        emit OracleRemoved(oracle, block.timestamp);
    }

    function approveOracleForContext(
        address oracle,
        OracleContext context
    ) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        contextApprovals[oracle][context] = true;

        emit OracleContextApproved(oracle, context);
    }

    function revokeOracleForContext(address oracle, OracleContext context) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        contextApprovals[oracle][context] = false;

        emit OracleContextRevoked(oracle, context);
    }

    function setOracleStatus(address oracle, OracleStatus status) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        oracles[oracle].status = status;
    }

    function setOracleMetadata(
        address oracle,
        address token,
        string calldata label,
        string calldata description
    ) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        address oldToken = oracleMetadata[oracle].token;

        if (oldToken != token) {
            if (oldToken != address(0)) {
                _removeOracleFromTokenList(oldToken, oracle);
            }

            if (token != address(0)) {
                _addOracleToTokenList(token, oracle);
            }
        }

        oracleMetadata[oracle] = OracleMetadata({
            token: token,
            label: label,
            description: description
        });

        emit OracleMetadataSet(oracle, token, label, description);
    }

    function setTokenAllowedForContext(
        address token,
        OracleContext context,
        bool allowed
    ) external onlyGovernance {
        tokenAllowedForContext[token][context] = allowed;

        emit TokenAllowedForContextSet(token, context, allowed);
    }

    function registerOracleForTokenContext(
        address token,
        OracleContext context,
        address oracle
    ) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();
        if (!contextApprovals[oracle][context]) {
            revert OracleNotApprovedForContext();
        }

        OracleMetadata storage meta = oracleMetadata[oracle];

        if (meta.token != token) {
            address oldToken = meta.token;

            if (oldToken != address(0)) {
                _removeOracleFromTokenList(oldToken, oracle);
            }

            meta.token = token;

            if (token != address(0)) {
                _addOracleToTokenList(token, oracle);
            }

            emit OracleMetadataSet(oracle, token, meta.label, meta.description);
        }

        address[] storage list = tokenContextOracles[token][context];

        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == oracle) {
                return;
            }
        }

        list.push(oracle);

        emit TokenContextOracleRegistered(token, context, oracle);
    }

    function removeOracleForTokenContext(
        address token,
        OracleContext context,
        address oracle
    ) external onlyGovernance {
        if (oracle == address(0)) revert ZeroAddress();
        address[] storage list = tokenContextOracles[token][context];
        uint256 len = list.length;

        for (uint256 i = 0; i < len; i++) {
            if (list[i] == oracle) {
                if (i != len - 1) {
                    list[i] = list[len - 1];
                }

                list.pop();

                emit TokenContextOracleRemoved(token, context, oracle);
                return;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Oracle views
    // -------------------------------------------------------------------------

    function getUsableOracleForTokenContext(
        address token,
        OracleContext context
    ) public view returns (bool ok, address oracle) {
        // tokenAllowedForContext is an identity/authenticity display flag.
        // Oracle usability is governed by explicit oracle approval, context approval,
        // registration for this token/context, and freshness/status checks.
        address[] storage list = tokenContextOracles[token][context];

        for (uint256 i = 0; i < list.length; i++) {
            address candidate = list[i];

            if (isOracleUsableForContext(candidate, context)) {
                return (true, candidate);
            }
        }

        return (false, address(0));
    }

    function getOraclesForTokenContext(
        address token,
        OracleContext context
    ) external view returns (address[] memory) {
        return tokenContextOracles[token][context];
    }

    function isApprovedOracle(address oracle) public view returns (bool) {
        return oracles[oracle].approved;
    }

    function isOracleApprovedFor(address oracle, OracleContext context) public view returns (bool) {
        return oracles[oracle].approved && contextApprovals[oracle][context];
    }

    function getOracleStatus(address oracle) external view returns (OracleStatus) {
        return oracles[oracle].status;
    }

    function getApprovedOracles() external view returns (address[] memory) {
        return approvedOracles;
    }

    function getApprovedOraclesForContext(
        OracleContext context
    ) external view returns (address[] memory list) {
        uint256 count;

        for (uint256 i = 0; i < approvedOracles.length; i++) {
            address oracle = approvedOracles[i];

            if (contextApprovals[oracle][context]) {
                count++;
            }
        }

        list = new address[](count);

        uint256 idx;

        for (uint256 i = 0; i < approvedOracles.length; i++) {
            address oracle = approvedOracles[i];

            if (contextApprovals[oracle][context]) {
                list[idx] = oracle;
                idx++;
            }
        }
    }

    function getOraclesForToken(address token) external view returns (address[] memory) {
        return tokenToOracles[token];
    }

    function getOracleMetadata(
        address oracle
    ) external view returns (OracleMetadata memory metadata) {
        return oracleMetadata[oracle];
    }

    function isOracleUsableForContext(
        address oracle,
        OracleContext context
    ) public view returns (bool) {
        OracleData memory od = oracles[oracle];

        if (!od.approved) return false;
        if (!contextApprovals[oracle][context]) return false;
        if (od.lastTimestamp == 0) return false;
        if (od.status != OracleStatus.OK) return false;
        if (block.timestamp > od.lastTimestamp + staleTimeout) return false;

        return true;
    }

    function isOracleUsableForFutures(address oracle) external view returns (bool) {
        return isOracleUsableForContext(oracle, OracleContext.FUTURE_SETTLEMENT);
    }

    // -------------------------------------------------------------------------
    // Oracle pricing
    // -------------------------------------------------------------------------

    function getOraclePrice(
        address oracle,
        OracleContext context
    )
        external
        view
        returns (uint256 price, uint8 priceDecimals, uint256 timestamp, OracleStatus status)
    {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();
        if (!contextApprovals[oracle][context]) {
            revert OracleNotApprovedForContext();
        }

        OracleData memory od = oracles[oracle];

        price = od.lastPrice;
        timestamp = od.lastTimestamp;
        status = od.status;
        priceDecimals = IPriceOracle(oracle).decimals();
    }

    function getOraclePriceInEth(
        address oracle,
        OracleContext context
    ) external view returns (uint256 priceE18) {
        if (!isOracleUsableForContext(oracle, context)) {
            revert OracleNotUsableForContext();
        }

        uint256 rawPrice = oracles[oracle].lastPrice;
        if (rawPrice == 0) revert MissingPrice();

        return _scalePriceToE18(rawPrice, IPriceOracle(oracle).decimals());
    }

    function tryGetOraclePriceInEth(
        address oracle,
        OracleContext context
    ) external view returns (bool ok, uint256 priceE18) {
        if (!isOracleUsableForContext(oracle, context)) {
            return (false, 0);
        }

        uint256 rawPrice = oracles[oracle].lastPrice;

        if (rawPrice == 0) {
            return (false, 0);
        }

        return (true, _scalePriceToE18(rawPrice, IPriceOracle(oracle).decimals()));
    }

    function isOracleUsableForFeeConversion(address oracle) public view returns (bool) {
        OracleData memory od = oracles[oracle];

        if (!od.approved) return false;
        if (!contextApprovals[oracle][OracleContext.FEE_CONVERSION]) return false;
        if (od.lastTimestamp == 0) return false;
        if (od.status != OracleStatus.OK) return false;
        if (od.lastPrice == 0) return false;

        return true;
    }

    function getFeeConversionRate(
        address token
    ) public view returns (uint256 tokenPerEthE18, address oracle) {
        if (token == address(0)) {
            return (WAD, address(0));
        }

        // tokenAllowedForContext is informational. Fee conversion requires an
        // approved, registered, usable fee-conversion oracle for the token.
        address[] storage list = tokenContextOracles[token][OracleContext.FEE_CONVERSION];

        for (uint256 i = 0; i < list.length; i++) {
            address candidate = list[i];

            if (isOracleUsableForFeeConversion(candidate)) {
                (uint256 rawRate, , , ) = IPriceOracle(candidate).getLastPrice();
                if (rawRate == 0) revert MissingPrice();
                return (_scalePriceToE18(rawRate, IPriceOracle(candidate).decimals()), candidate);
            }
        }

        revert FeeConversionOracleUnavailable();
    }

    function convertEthFeeToToken(
        address token,
        uint256 ethAmount
    ) external view returns (uint256 tokenAmount) {
        if (ethAmount == 0) {
            return 0;
        }

        (uint256 tokenPerEthE18, ) = getFeeConversionRate(token);
        return Math.mulDiv(ethAmount, tokenPerEthE18, WAD);
    }

    function getConvertedValue(
        address assetOracle,
        uint256 assetAmount,
        address paymentOracle
    ) external view returns (uint256 paymentAmount) {
        OracleContext ctx = OracleContext.TRADE_VALUE;

        if (!isOracleUsableForContext(assetOracle, ctx)) {
            revert OracleNotUsableForContext();
        }

        if (!isOracleUsableForContext(paymentOracle, ctx)) {
            revert OracleNotUsableForContext();
        }

        uint256 assetPrice = oracles[assetOracle].lastPrice;
        uint256 paymentPrice = oracles[paymentOracle].lastPrice;

        if (assetPrice == 0 || paymentPrice == 0) revert MissingPrice();

        uint8 assetOracleDec = IPriceOracle(assetOracle).decimals();
        uint8 paymentOracleDec = IPriceOracle(paymentOracle).decimals();

        paymentAmount = Math.mulDiv(assetAmount, assetPrice, paymentPrice);

        if (paymentOracleDec > assetOracleDec) {
            paymentAmount *= 10 ** uint256(paymentOracleDec - assetOracleDec);
        } else if (assetOracleDec > paymentOracleDec) {
            paymentAmount /= 10 ** uint256(assetOracleDec - paymentOracleDec);
        }
    }

    // -------------------------------------------------------------------------
    // Oracle interaction
    // -------------------------------------------------------------------------

    function fetchPrice(address oracle) external {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        IPriceOracle(oracle).fetchPrice();
    }

    function syncOracleData(address oracle) external {
        if (oracle == address(0)) revert ZeroAddress();
        if (!oracles[oracle].approved) revert OracleNotApproved();

        try IPriceOracle(oracle).getLastPrice() returns (
            uint256 fetchedPrice,
            uint256 fetchedTimestamp,
            uint256,
            string memory statusString
        ) {
            OracleData storage o = oracles[oracle];

            o.lastPrice = fetchedPrice;
            o.lastTimestamp = fetchedTimestamp;
            o.status = _interpretStatus(statusString);

            emit OracleSynced(oracle, fetchedPrice, statusString, fetchedTimestamp);

            if (fetchedPrice != 0 && fetchedTimestamp != 0) {
                _recordFirstPriceOfDayIfNeeded(oracle, fetchedPrice, fetchedTimestamp);
            }
        } catch {
            emit OracleSyncFailed(oracle);
        }
    }

    // -------------------------------------------------------------------------
    // Snapshots
    // -------------------------------------------------------------------------

    function getOracleSnapshot(
        address oracle,
        uint256 day
    ) external view returns (bool exists, OracleSnapshot memory snapshot) {
        snapshot = dailySnapshots[oracle][day];
        exists = snapshot.timestamp != 0;
    }

    function getFirstSnapshotAfter(
        address oracle,
        uint256 startDay,
        uint256 maxDaysToScan
    ) external view returns (bool exists, OracleSnapshot memory snapshot) {
        uint256 day = startDay;
        uint256 end = startDay + maxDaysToScan;

        while (day <= end) {
            OracleSnapshot memory candidate = dailySnapshots[oracle][day];

            if (candidate.timestamp != 0) {
                return (true, candidate);
            }

            day++;
        }

        return (false, OracleSnapshot(0, 0, OracleStatus.PENDING));
    }

    function hasSyncedToday(address oracle) external view returns (bool) {
        if (!oracles[oracle].approved) return false;

        uint256 day = block.timestamp / 1 days;

        return dailySnapshots[oracle][day].timestamp != 0;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _scalePriceToE18(
        uint256 rawPrice,
        uint8 oracleDecimals
    ) internal pure returns (uint256) {
        if (oracleDecimals == 18) {
            return rawPrice;
        }

        if (oracleDecimals < 18) {
            return rawPrice * (10 ** uint256(18 - oracleDecimals));
        }

        return rawPrice / (10 ** uint256(oracleDecimals - 18));
    }

    function _interpretStatus(string memory s) internal pure returns (OracleStatus) {
        bytes32 h = keccak256(bytes(s));

        if (h == keccak256("OK")) return OracleStatus.OK;
        if (h == keccak256("ok")) return OracleStatus.OK;
        if (h == keccak256("stale")) return OracleStatus.STALE;
        if (h == keccak256("STALE")) return OracleStatus.STALE;
        if (h == keccak256("frozen")) return OracleStatus.FROZEN;
        if (h == keccak256("FROZEN")) return OracleStatus.FROZEN;
        if (h == keccak256("pending")) return OracleStatus.PENDING;
        if (h == keccak256("PENDING")) return OracleStatus.PENDING;

        return OracleStatus.DEGRADED;
    }

    function _recordFirstPriceOfDayIfNeeded(address oracle, uint256 price, uint256 ts) internal {
        uint256 day = ts / 1 days;
        OracleSnapshot storage snap = dailySnapshots[oracle][day];

        if (snap.timestamp == 0) {
            snap.price = price;
            snap.timestamp = ts;
            snap.status = oracles[oracle].status;

            emit FirstPriceOfDayRecorded(oracle, day, price);
        }
    }

    function _addOracleToList(address oracle) internal {
        if (oracleIndexPlus1[oracle] != 0) return;

        approvedOracles.push(oracle);
        oracleIndexPlus1[oracle] = approvedOracles.length;
    }

    function _removeOracleFromList(address oracle) internal {
        uint256 idxPlus1 = oracleIndexPlus1[oracle];

        if (idxPlus1 == 0) return;

        uint256 idx = idxPlus1 - 1;
        uint256 lastIdx = approvedOracles.length - 1;

        if (idx != lastIdx) {
            address lastOracle = approvedOracles[lastIdx];
            approvedOracles[idx] = lastOracle;
            oracleIndexPlus1[lastOracle] = idx + 1;
        }

        approvedOracles.pop();
        oracleIndexPlus1[oracle] = 0;
    }

    function _removeOracleFromTokenContextList(
        address token,
        OracleContext context,
        address oracle
    ) internal {
        address[] storage list = tokenContextOracles[token][context];
        uint256 len = list.length;

        for (uint256 i = 0; i < len; i++) {
            if (list[i] == oracle) {
                if (i != len - 1) {
                    list[i] = list[len - 1];
                }

                list.pop();
                return;
            }
        }
    }

    function _addOracleToTokenList(address token, address oracle) internal {
        if (tokenOracleListed[token][oracle]) return;

        tokenToOracles[token].push(oracle);
        tokenOracleListed[token][oracle] = true;
    }

    function _removeOracleFromTokenList(address token, address oracle) internal {
        if (!tokenOracleListed[token][oracle]) return;

        address[] storage list = tokenToOracles[token];
        uint256 len = list.length;

        for (uint256 i = 0; i < len; i++) {
            if (list[i] == oracle) {
                if (i != len - 1) {
                    list[i] = list[len - 1];
                }

                list.pop();
                tokenOracleListed[token][oracle] = false;
                return;
            }
        }

        tokenOracleListed[token][oracle] = false;
    }
}
