// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FounderTokenTimelock {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ReleaseTimeNotFuture();
    error TokensStillLocked();
    error NoTokensToRelease();

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint256 public immutable releaseTime;

    event FounderTokensReleased(address indexed token, address indexed beneficiary, uint256 amount);

    constructor(address token_, address beneficiary_, uint256 releaseTime_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (beneficiary_ == address(0)) revert ZeroAddress();
        if (releaseTime_ <= block.timestamp) revert ReleaseTimeNotFuture();

        token = IERC20(token_);
        beneficiary = beneficiary_;
        releaseTime = releaseTime_;
    }

    function releasable() external view returns (uint256) {
        if (block.timestamp < releaseTime) {
            return 0;
        }

        return token.balanceOf(address(this));
    }

    function release() external {
        if (block.timestamp < releaseTime) revert TokensStillLocked();

        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert NoTokensToRelease();

        token.safeTransfer(beneficiary, amount);

        emit FounderTokensReleased(address(token), beneficiary, amount);
    }
}
