// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFeeOnTransferERC20 is ERC20 {
    uint8 private immutable _customDecimals;
    uint256 public feeBps;
    address public feeCollector;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_,
        address feeCollector_
    ) ERC20(name_, symbol_) {
        require(feeBps_ <= 1_000, "fee too high");
        require(feeCollector_ != address(0), "zero fee collector");

        _customDecimals = decimals_;
        feeBps = feeBps_;
        feeCollector = feeCollector_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, amount);
            return;
        }

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 net = amount - fee;

        super._update(from, feeCollector, fee);
        super._update(from, to, net);
    }
}
