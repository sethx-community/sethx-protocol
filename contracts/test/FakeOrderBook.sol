// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract FakeOrderBook {
    event FakeAction(address indexed caller, bytes data);

    function placeOrder(bytes calldata data) external {
        emit FakeAction(msg.sender, data);
    }

    function acceptOrder(uint256 orderId) external {
        emit FakeAction(msg.sender, abi.encode(orderId));
    }
}
