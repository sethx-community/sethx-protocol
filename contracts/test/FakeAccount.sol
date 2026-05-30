// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract FakeAccount {
    function callTarget(
        address target,
        bytes calldata data,
        uint256 value
    ) external payable returns (bytes memory result) {
        (bool ok, bytes memory ret) = target.call{ value: value }(data);
        require(ok, "fake call failed");
        return ret;
    }

    receive() external payable {}
}
