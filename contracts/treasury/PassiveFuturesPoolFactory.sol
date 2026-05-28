// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { AccountRegistry } from "../accounts/AccountRegistry.sol";
import { PassiveLiquidityPool } from "./PassiveLiquidityPool.sol";

interface IFuturesOrderBookPassiveAdmin {
    function setPassivePool(bytes32 marketKey, address pool) external;
    function setPassivePublisher(address publisher, bool enabled) external;
}

contract PassiveFuturesPoolFactory is AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    struct PoolInfo {
        address pool;
        address publisher;
        uint256 createdAt;
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

    error ZeroAddress();
    error InvalidMarketKey();
    error PoolAlreadyExists();

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
            createdAt: block.timestamp
        });

        marketKeys.push(marketKey);

        emit PassivePoolCreated(marketKey, pool, publisher);
        emit PassivePublisherApproved(publisher, true);
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
