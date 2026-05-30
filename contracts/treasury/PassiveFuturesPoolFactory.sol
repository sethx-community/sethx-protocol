// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { AccountRegistry } from "../accounts/AccountRegistry.sol";
import { PassiveLiquidityPool } from "./PassiveLiquidityPool.sol";

interface IFuturesOrderBookPassiveAdmin {
    function setPassivePool(bytes32 marketKey, address pool) external;
    function setPassivePublisher(address publisher, bool enabled) external;
    function clearPassiveSnapshot(bytes32 marketKey) external;
}

interface IPassiveLiquidityPoolAdmin {
    function setActive(bool enabled) external;
}

contract PassiveFuturesPoolFactory is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    enum PoolStatus {
        Unknown,
        Active,
        Inactive
    }

    struct PoolInfo {
        address pool;
        address publisher;
        uint256 createdAt;
        PoolStatus status;
    }

    address public immutable futures;
    address public immutable vault;
    address public immutable accountRegistry;
    address public immutable orderBook;

    mapping(bytes32 => PoolInfo) public poolForMarket;
    bytes32[] public marketKeys;

    event PassivePoolCreated(
        bytes32 indexed marketKey,
        address indexed pool,
        address indexed publisher
    );

    event PassivePublisherApproved(address indexed publisher, bool enabled);
    event PassivePoolStatusSet(bytes32 indexed marketKey, address indexed pool, PoolStatus status);

    error ZeroAddress();
    error InvalidMarketKey();
    error PoolAlreadyExists();
    error PoolNotFound();
    error Unauthorized();

    constructor(
        address futures_,
        address vault_,
        address accountRegistry_,
        address orderBook_,
        address admin_
    ) {
        if (futures_ == address(0)) revert ZeroAddress();
        if (vault_ == address(0)) revert ZeroAddress();
        if (accountRegistry_ == address(0)) revert ZeroAddress();
        if (orderBook_ == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();

        futures = futures_;
        vault = vault_;
        accountRegistry = accountRegistry_;
        orderBook = orderBook_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(GOVERNOR_ROLE, admin_);
    }

    function createPool(
        bytes32 marketKey,
        address publisher
    ) external onlyRole(GOVERNOR_ROLE) returns (address pool) {
        if (marketKey == bytes32(0)) revert InvalidMarketKey();
        if (publisher == address(0)) revert ZeroAddress();
        if (poolForMarket[marketKey].pool != address(0)) revert PoolAlreadyExists();

        pool = address(
            new PassiveLiquidityPool(
                futures,
                vault,
                accountRegistry,
                marketKey,
                msg.sender,
                address(this)
            )
        );

        AccountRegistry(accountRegistry).registerAccount(address(this), pool);

        IFuturesOrderBookPassiveAdmin(orderBook).setPassivePool(marketKey, pool);
        IFuturesOrderBookPassiveAdmin(orderBook).setPassivePublisher(publisher, true);

        poolForMarket[marketKey] = PoolInfo({
            pool: pool,
            publisher: publisher,
            createdAt: block.timestamp,
            status: PoolStatus.Active
        });

        marketKeys.push(marketKey);

        emit PassivePoolCreated(marketKey, pool, publisher);
        emit PassivePoolStatusSet(marketKey, pool, PoolStatus.Active);
        emit PassivePublisherApproved(publisher, true);
    }

    function setPoolActive(bytes32 marketKey, bool enabled) external onlyRole(GOVERNOR_ROLE) {
        PoolInfo storage info = poolForMarket[marketKey];
        if (info.pool == address(0)) revert PoolNotFound();

        info.status = enabled ? PoolStatus.Active : PoolStatus.Inactive;
        IPassiveLiquidityPoolAdmin(info.pool).setActive(enabled);

        if (!enabled) {
            IFuturesOrderBookPassiveAdmin(orderBook).clearPassiveSnapshot(marketKey);
        }

        emit PassivePoolStatusSet(marketKey, info.pool, info.status);
    }

    function closePool(bytes32 marketKey) external {
        PoolInfo storage info = poolForMarket[marketKey];
        if (info.pool == address(0)) revert PoolNotFound();
        if (!hasRole(GOVERNOR_ROLE, msg.sender) && msg.sender != info.publisher) revert Unauthorized();

        info.status = PoolStatus.Inactive;
        IPassiveLiquidityPoolAdmin(info.pool).setActive(false);
        IFuturesOrderBookPassiveAdmin(orderBook).clearPassiveSnapshot(marketKey);

        emit PassivePoolStatusSet(marketKey, info.pool, PoolStatus.Inactive);
    }

    function reopenPool(bytes32 marketKey) external onlyRole(GOVERNOR_ROLE) {
        PoolInfo storage info = poolForMarket[marketKey];
        if (info.pool == address(0)) revert PoolNotFound();

        info.status = PoolStatus.Active;
        IPassiveLiquidityPoolAdmin(info.pool).setActive(true);

        emit PassivePoolStatusSet(marketKey, info.pool, PoolStatus.Active);
    }

    function isPoolActive(bytes32 marketKey) external view returns (bool) {
        return poolForMarket[marketKey].status == PoolStatus.Active;
    }

    function approvePassivePublisher(
        address publisher,
        bool enabled
    ) external onlyRole(GOVERNOR_ROLE) {
        if (publisher == address(0)) revert ZeroAddress();

        IFuturesOrderBookPassiveAdmin(orderBook).setPassivePublisher(publisher, enabled);

        emit PassivePublisherApproved(publisher, enabled);
    }

    function marketCount() external view returns (uint256) {
        return marketKeys.length;
    }

    function getMarketKeys() external view returns (bytes32[] memory) {
        return marketKeys;
    }
}
