// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract SethxToken is ERC20 {
    error MintingFinished();
    error NotMinter();
    error ZeroAddress();
    error ZeroAmount();

    address public minter;
    bool public mintingFinished;

    event MinterChanged(address indexed oldMinter, address indexed newMinter);
    event MintingFinalized(address indexed minter);

    constructor(address initialMinter) ERC20("SETHX", "SETHX") {
        if (initialMinter == address(0)) revert ZeroAddress();
        minter = initialMinter;
        emit MinterChanged(address(0), initialMinter);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        if (mintingFinished) revert MintingFinished();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _mint(to, amount);
    }

    function finishMinting() external onlyMinter {
        if (mintingFinished) revert MintingFinished();

        mintingFinished = true;

        address oldMinter = minter;
        minter = address(0);

        emit MintingFinalized(oldMinter);
        emit MinterChanged(oldMinter, address(0));
    }
}