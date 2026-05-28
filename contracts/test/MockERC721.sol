// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockERC721 is ERC721 {
    uint256 public nextTokenId = 1;

    constructor(
        string memory name_,
        string memory symbol_
    ) ERC721(name_, symbol_) {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextTokenId;
        nextTokenId++;

        _mint(to, tokenId);
    }

    function mintSpecific(address to, uint256 tokenId) external {
        _mint(to, tokenId);

        if (tokenId >= nextTokenId) {
            nextTokenId = tokenId + 1;
        }
    }
}