// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { FuturesTypes } from "./FuturesTypes.sol";

/// @notice Index store for futures liquidation and reference-price queues.
/// @dev Canonical positions and open interest live in FuturesContract.
contract FuturesPositionStore is AccessControl {
    bytes32 public constant FUTURES_ENGINE_ROLE = keccak256("FUTURES_ENGINE_ROLE");

    // -------- Errors --------
    error ZeroAddress();
    error InvalidPositionSide();
    error InvalidPrice();
    error InvalidIndex();
    error PositionAlreadyIndexed();

    // -------- Liquidation index --------

    mapping(bytes32 => mapping(FuturesTypes.PositionSide => FuturesTypes.LiquidationList))
        private liquidationLists;

    mapping(bytes32 => mapping(address => FuturesTypes.LiquidationNode)) private liquidationNodes;

    mapping(bytes32 => mapping(FuturesTypes.PositionSide => mapping(uint256 => address)))
        private liquidationTickAnchors;

    // -------- Reference-price / loser index --------

    mapping(bytes32 => mapping(FuturesTypes.PositionSide => FuturesTypes.ReferencePriceList))
        private referencePriceLists;

    mapping(bytes32 => mapping(address => FuturesTypes.ReferencePriceNode))
        private referencePriceNodes;

    mapping(bytes32 => mapping(FuturesTypes.PositionSide => mapping(uint256 => address)))
        private referencePriceTickAnchors;

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FUTURES_ENGINE_ROLE, admin);
    }

    // -------- Liquidation index writes --------

    function reindexLiquidationPosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice,
        uint256 liquidationTick
    ) external onlyRole(FUTURES_ENGINE_ROLE) {
        _reindexLiquidationPosition(marketKey, account, side, liquidationPrice, liquidationTick);
    }

    function clearLiquidationPosition(
        bytes32 marketKey,
        address account
    ) external onlyRole(FUTURES_ENGINE_ROLE) {
        _clearLiquidationPosition(marketKey, account);
    }

    // -------- Reference-price index writes --------

    function reindexReferencePricePosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 referencePrice,
        uint256 referenceTick
    ) external onlyRole(FUTURES_ENGINE_ROLE) {
        _reindexReferencePricePosition(marketKey, account, side, referencePrice, referenceTick);
    }

    function clearReferencePricePosition(
        bytes32 marketKey,
        address account
    ) external onlyRole(FUTURES_ENGINE_ROLE) {
        _clearReferencePricePosition(marketKey, account);
    }

    // -------- Views --------

    function getLiquidationList(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (FuturesTypes.LiquidationList memory) {
        _requirePositionSide(side);
        return liquidationLists[marketKey][side];
    }

    function getLiquidationNode(
        bytes32 marketKey,
        address account
    ) external view returns (FuturesTypes.LiquidationNode memory) {
        return liquidationNodes[marketKey][account];
    }

    function getLiquidationHead(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (address) {
        _requirePositionSide(side);
        return liquidationLists[marketKey][side].head;
    }

    function getLiquidationTail(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (address) {
        _requirePositionSide(side);
        return liquidationLists[marketKey][side].tail;
    }

    function getLiquidationTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick
    ) external view returns (address) {
        _requirePositionSide(side);
        return liquidationTickAnchors[marketKey][side][tick];
    }

    function getReferencePriceList(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (FuturesTypes.ReferencePriceList memory) {
        _requirePositionSide(side);
        return referencePriceLists[marketKey][side];
    }

    function getReferencePriceNode(
        bytes32 marketKey,
        address account
    ) external view returns (FuturesTypes.ReferencePriceNode memory) {
        return referencePriceNodes[marketKey][account];
    }

    function getReferencePriceHead(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (address) {
        _requirePositionSide(side);
        return referencePriceLists[marketKey][side].head;
    }

    function getReferencePriceTail(
        bytes32 marketKey,
        FuturesTypes.PositionSide side
    ) external view returns (address) {
        _requirePositionSide(side);
        return referencePriceLists[marketKey][side].tail;
    }

    function getReferencePriceTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick
    ) external view returns (address) {
        _requirePositionSide(side);
        return referencePriceTickAnchors[marketKey][side][tick];
    }

    // -------- Internal: liquidation index --------

    function _reindexLiquidationPosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice,
        uint256 liquidationTick
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requirePositionSide(side);
        // Zero liquidation price is a valid sentinel only for overcollateralized
        // long positions. It remains invalid for shorts.
        if (liquidationPrice == 0 && side != FuturesTypes.PositionSide.Long) {
            revert InvalidPrice();
        }

        _clearLiquidationPosition(marketKey, account);

        _insertLiquidationNodeByScan(marketKey, account, side, liquidationPrice, liquidationTick);
    }

    function _clearLiquidationPosition(bytes32 marketKey, address account) internal {
        if (liquidationNodes[marketKey][account].active) {
            _removeFromLiquidationIndex(marketKey, account);
        }
    }

    function _insertLiquidationNodeByScan(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice,
        uint256 liquidationTick
    ) internal {
        FuturesTypes.LiquidationList storage list = liquidationLists[marketKey][side];

        if (list.count == 0 || list.head == address(0)) {
            _insertBetweenLiquidationNodes(
                marketKey,
                account,
                side,
                liquidationPrice,
                liquidationTick,
                address(0),
                address(0)
            );
            return;
        }

        address current = list.head;
        address prev = address(0);

        while (current != address(0)) {
            FuturesTypes.LiquidationNode storage currentNode = liquidationNodes[marketKey][current];

            if (!currentNode.active || currentNode.side != side) {
                _clearStaleLiquidationNode(marketKey, side, current);
                current = list.head;
                prev = address(0);
                continue;
            }

            if (_liquidationComesBefore(side, liquidationPrice, currentNode.liquidationPrice)) {
                _insertBetweenLiquidationNodes(
                    marketKey,
                    account,
                    side,
                    liquidationPrice,
                    liquidationTick,
                    prev,
                    current
                );
                return;
            }

            prev = current;
            current = currentNode.next;
        }

        _insertBetweenLiquidationNodes(
            marketKey,
            account,
            side,
            liquidationPrice,
            liquidationTick,
            prev,
            address(0)
        );
    }

    function _insertBetweenLiquidationNodes(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 liquidationPrice,
        uint256 liquidationTick,
        address prev,
        address next
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requirePositionSide(side);

        if (liquidationNodes[marketKey][account].active) {
            revert PositionAlreadyIndexed();
        }

        FuturesTypes.LiquidationList storage list = liquidationLists[marketKey][side];

        if (list.count == 0) {
            if (prev != address(0) || next != address(0)) revert InvalidIndex();

            list.head = account;
            list.tail = account;
        } else {
            if (prev == address(0) && list.head != next) revert InvalidIndex();
            if (next == address(0) && list.tail != prev) revert InvalidIndex();

            if (prev != address(0)) {
                FuturesTypes.LiquidationNode storage prevNode = liquidationNodes[marketKey][prev];

                if (!prevNode.active || prevNode.side != side) revert InvalidIndex();

                if (
                    !_liquidationDoesNotComeAfter(side, prevNode.liquidationPrice, liquidationPrice)
                ) {
                    revert InvalidIndex();
                }
            }

            if (next != address(0)) {
                FuturesTypes.LiquidationNode storage nextNode = liquidationNodes[marketKey][next];

                if (!nextNode.active || nextNode.side != side) revert InvalidIndex();

                if (
                    !_liquidationDoesNotComeAfter(side, liquidationPrice, nextNode.liquidationPrice)
                ) {
                    revert InvalidIndex();
                }
            }

            if (prev != address(0)) {
                liquidationNodes[marketKey][prev].next = account;
            } else {
                list.head = account;
            }

            if (next != address(0)) {
                liquidationNodes[marketKey][next].prev = account;
            } else {
                list.tail = account;
            }
        }

        liquidationNodes[marketKey][account] = FuturesTypes.LiquidationNode({
            active: true,
            side: side,
            liquidationPrice: liquidationPrice,
            liquidationTick: liquidationTick,
            prev: prev,
            next: next
        });

        list.count++;

        _setLiquidationTickAnchorIfBetter(marketKey, side, liquidationTick, account);
    }

    function _removeFromLiquidationIndex(bytes32 marketKey, address account) internal {
        FuturesTypes.LiquidationNode storage node = liquidationNodes[marketKey][account];

        if (!node.active) return;

        FuturesTypes.PositionSide side = node.side;
        uint256 tick = node.liquidationTick;

        FuturesTypes.LiquidationList storage list = liquidationLists[marketKey][side];

        address prev = node.prev;
        address next = node.next;

        if (prev == address(0)) {
            list.head = next;
        } else {
            liquidationNodes[marketKey][prev].next = next;
        }

        if (next == address(0)) {
            list.tail = prev;
        } else {
            liquidationNodes[marketKey][next].prev = prev;
        }

        if (list.count > 0) {
            list.count--;
        }

        _removeFromLiquidationTickAnchor(marketKey, side, tick, account);

        delete liquidationNodes[marketKey][account];
    }

    function _clearStaleLiquidationNode(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        address account
    ) internal {
        FuturesTypes.LiquidationList storage list = liquidationLists[marketKey][side];
        FuturesTypes.LiquidationNode storage node = liquidationNodes[marketKey][account];

        address prev = node.prev;
        address next = node.next;

        if (prev != address(0)) {
            liquidationNodes[marketKey][prev].next = next;
        } else if (list.head == account) {
            list.head = next;
        }

        if (next != address(0)) {
            liquidationNodes[marketKey][next].prev = prev;
        } else if (list.tail == account) {
            list.tail = prev;
        }

        if (list.count > 0) {
            list.count--;
        }

        _removeFromLiquidationTickAnchor(marketKey, side, node.liquidationTick, account);

        delete liquidationNodes[marketKey][account];
    }

    function _setLiquidationTickAnchorIfBetter(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address account
    ) internal {
        FuturesTypes.LiquidationNode storage node = liquidationNodes[marketKey][account];

        if (!node.active || node.side != side || node.liquidationTick != tick) {
            return;
        }

        address current = liquidationTickAnchors[marketKey][side][tick];

        if (current == address(0)) {
            liquidationTickAnchors[marketKey][side][tick] = account;
            return;
        }

        FuturesTypes.LiquidationNode storage currentNode = liquidationNodes[marketKey][current];

        if (
            !currentNode.active ||
            currentNode.side != side ||
            currentNode.liquidationTick != tick ||
            _liquidationComesBefore(side, node.liquidationPrice, currentNode.liquidationPrice)
        ) {
            liquidationTickAnchors[marketKey][side][tick] = account;
        }
    }

    function _removeFromLiquidationTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address account
    ) internal {
        if (liquidationTickAnchors[marketKey][side][tick] != account) {
            return;
        }

        liquidationTickAnchors[marketKey][side][tick] = _findReplacementLiquidationAnchorNear(
            marketKey,
            side,
            tick,
            liquidationNodes[marketKey][account].prev,
            liquidationNodes[marketKey][account].next
        );
    }

    function _findReplacementLiquidationAnchorNear(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address prev,
        address next
    ) internal view returns (address best) {
        address cursor = prev;

        while (cursor != address(0)) {
            FuturesTypes.LiquidationNode storage node = liquidationNodes[marketKey][cursor];

            if (!node.active || node.side != side || node.liquidationTick != tick) {
                break;
            }

            if (
                best == address(0) ||
                _liquidationComesBefore(
                    side,
                    node.liquidationPrice,
                    liquidationNodes[marketKey][best].liquidationPrice
                )
            ) {
                best = cursor;
            }

            cursor = node.prev;
        }

        cursor = next;

        while (cursor != address(0)) {
            FuturesTypes.LiquidationNode storage node = liquidationNodes[marketKey][cursor];

            if (!node.active || node.side != side || node.liquidationTick != tick) {
                break;
            }

            if (
                best == address(0) ||
                _liquidationComesBefore(
                    side,
                    node.liquidationPrice,
                    liquidationNodes[marketKey][best].liquidationPrice
                )
            ) {
                best = cursor;
            }

            cursor = node.next;
        }
    }

    // -------- Internal: reference-price index --------

    function _reindexReferencePricePosition(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 referencePrice,
        uint256 referenceTick
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requirePositionSide(side);
        if (referencePrice == 0) revert InvalidPrice();

        _clearReferencePricePosition(marketKey, account);

        _insertReferencePriceNodeByScan(marketKey, account, side, referencePrice, referenceTick);
    }

    function _clearReferencePricePosition(bytes32 marketKey, address account) internal {
        if (referencePriceNodes[marketKey][account].active) {
            _removeFromReferencePriceIndex(marketKey, account);
        }
    }

    function _insertReferencePriceNodeByScan(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 referencePrice,
        uint256 referenceTick
    ) internal {
        FuturesTypes.ReferencePriceList storage list = referencePriceLists[marketKey][side];

        if (list.count == 0 || list.head == address(0)) {
            _insertBetweenReferencePriceNodes(
                marketKey,
                account,
                side,
                referencePrice,
                referenceTick,
                address(0),
                address(0)
            );
            return;
        }

        address current = list.head;
        address prev = address(0);

        while (current != address(0)) {
            FuturesTypes.ReferencePriceNode storage currentNode = referencePriceNodes[marketKey][
                current
            ];

            if (!currentNode.active || currentNode.side != side) {
                _clearStaleReferencePriceNode(marketKey, side, current);
                current = list.head;
                prev = address(0);
                continue;
            }

            if (_referenceComesBefore(side, referencePrice, currentNode.referencePrice)) {
                _insertBetweenReferencePriceNodes(
                    marketKey,
                    account,
                    side,
                    referencePrice,
                    referenceTick,
                    prev,
                    current
                );
                return;
            }

            prev = current;
            current = currentNode.next;
        }

        _insertBetweenReferencePriceNodes(
            marketKey,
            account,
            side,
            referencePrice,
            referenceTick,
            prev,
            address(0)
        );
    }

    function _insertBetweenReferencePriceNodes(
        bytes32 marketKey,
        address account,
        FuturesTypes.PositionSide side,
        uint256 referencePrice,
        uint256 referenceTick,
        address prev,
        address next
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        _requirePositionSide(side);

        if (referencePriceNodes[marketKey][account].active) {
            revert PositionAlreadyIndexed();
        }

        FuturesTypes.ReferencePriceList storage list = referencePriceLists[marketKey][side];

        if (list.count == 0) {
            if (prev != address(0) || next != address(0)) revert InvalidIndex();

            list.head = account;
            list.tail = account;
        } else {
            if (prev == address(0) && list.head != next) revert InvalidIndex();
            if (next == address(0) && list.tail != prev) revert InvalidIndex();

            if (prev != address(0)) {
                FuturesTypes.ReferencePriceNode storage prevNode = referencePriceNodes[marketKey][
                    prev
                ];

                if (!prevNode.active || prevNode.side != side) revert InvalidIndex();

                if (!_referenceDoesNotComeAfter(side, prevNode.referencePrice, referencePrice)) {
                    revert InvalidIndex();
                }
            }

            if (next != address(0)) {
                FuturesTypes.ReferencePriceNode storage nextNode = referencePriceNodes[marketKey][
                    next
                ];

                if (!nextNode.active || nextNode.side != side) revert InvalidIndex();

                if (!_referenceDoesNotComeAfter(side, referencePrice, nextNode.referencePrice)) {
                    revert InvalidIndex();
                }
            }

            if (prev != address(0)) {
                referencePriceNodes[marketKey][prev].next = account;
            } else {
                list.head = account;
            }

            if (next != address(0)) {
                referencePriceNodes[marketKey][next].prev = account;
            } else {
                list.tail = account;
            }
        }

        referencePriceNodes[marketKey][account] = FuturesTypes.ReferencePriceNode({
            active: true,
            side: side,
            referencePrice: referencePrice,
            referenceTick: referenceTick,
            prev: prev,
            next: next
        });

        list.count++;

        _setReferencePriceTickAnchorIfBetter(marketKey, side, referenceTick, account);
    }

    function _removeFromReferencePriceIndex(bytes32 marketKey, address account) internal {
        FuturesTypes.ReferencePriceNode storage node = referencePriceNodes[marketKey][account];

        if (!node.active) return;

        FuturesTypes.PositionSide side = node.side;
        uint256 tick = node.referenceTick;

        FuturesTypes.ReferencePriceList storage list = referencePriceLists[marketKey][side];

        address prev = node.prev;
        address next = node.next;

        if (prev == address(0)) {
            list.head = next;
        } else {
            referencePriceNodes[marketKey][prev].next = next;
        }

        if (next == address(0)) {
            list.tail = prev;
        } else {
            referencePriceNodes[marketKey][next].prev = prev;
        }

        if (list.count > 0) {
            list.count--;
        }

        _removeFromReferencePriceTickAnchor(marketKey, side, tick, account);

        delete referencePriceNodes[marketKey][account];
    }

    function _clearStaleReferencePriceNode(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        address account
    ) internal {
        FuturesTypes.ReferencePriceList storage list = referencePriceLists[marketKey][side];
        FuturesTypes.ReferencePriceNode storage node = referencePriceNodes[marketKey][account];

        address prev = node.prev;
        address next = node.next;

        if (prev != address(0)) {
            referencePriceNodes[marketKey][prev].next = next;
        } else if (list.head == account) {
            list.head = next;
        }

        if (next != address(0)) {
            referencePriceNodes[marketKey][next].prev = prev;
        } else if (list.tail == account) {
            list.tail = prev;
        }

        if (list.count > 0) {
            list.count--;
        }

        _removeFromReferencePriceTickAnchor(marketKey, side, node.referenceTick, account);

        delete referencePriceNodes[marketKey][account];
    }

    function _setReferencePriceTickAnchorIfBetter(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address account
    ) internal {
        FuturesTypes.ReferencePriceNode storage node = referencePriceNodes[marketKey][account];

        if (!node.active || node.side != side || node.referenceTick != tick) {
            return;
        }

        address current = referencePriceTickAnchors[marketKey][side][tick];

        if (current == address(0)) {
            referencePriceTickAnchors[marketKey][side][tick] = account;
            return;
        }

        FuturesTypes.ReferencePriceNode storage currentNode = referencePriceNodes[marketKey][
            current
        ];

        if (
            !currentNode.active ||
            currentNode.side != side ||
            currentNode.referenceTick != tick ||
            _referenceComesBefore(side, node.referencePrice, currentNode.referencePrice)
        ) {
            referencePriceTickAnchors[marketKey][side][tick] = account;
        }
    }

    function _removeFromReferencePriceTickAnchor(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address account
    ) internal {
        if (referencePriceTickAnchors[marketKey][side][tick] != account) {
            return;
        }

        referencePriceTickAnchors[marketKey][side][tick] = _findReplacementReferencePriceAnchorNear(
            marketKey,
            side,
            tick,
            referencePriceNodes[marketKey][account].prev,
            referencePriceNodes[marketKey][account].next
        );
    }

    function _findReplacementReferencePriceAnchorNear(
        bytes32 marketKey,
        FuturesTypes.PositionSide side,
        uint256 tick,
        address prev,
        address next
    ) internal view returns (address best) {
        address cursor = prev;

        while (cursor != address(0)) {
            FuturesTypes.ReferencePriceNode storage node = referencePriceNodes[marketKey][cursor];

            if (!node.active || node.side != side || node.referenceTick != tick) {
                break;
            }

            if (
                best == address(0) ||
                _referenceComesBefore(
                    side,
                    node.referencePrice,
                    referencePriceNodes[marketKey][best].referencePrice
                )
            ) {
                best = cursor;
            }

            cursor = node.prev;
        }

        cursor = next;

        while (cursor != address(0)) {
            FuturesTypes.ReferencePriceNode storage node = referencePriceNodes[marketKey][cursor];

            if (!node.active || node.side != side || node.referenceTick != tick) {
                break;
            }

            if (
                best == address(0) ||
                _referenceComesBefore(
                    side,
                    node.referencePrice,
                    referencePriceNodes[marketKey][best].referencePrice
                )
            ) {
                best = cursor;
            }

            cursor = node.next;
        }
    }

    // -------- Ordering helpers --------

    function _liquidationComesBefore(
        FuturesTypes.PositionSide side,
        uint256 aLiquidationPrice,
        uint256 bLiquidationPrice
    ) internal pure returns (bool) {
        _requirePositionSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return aLiquidationPrice > bLiquidationPrice;
        }

        return aLiquidationPrice < bLiquidationPrice;
    }

    function _liquidationDoesNotComeAfter(
        FuturesTypes.PositionSide side,
        uint256 aLiquidationPrice,
        uint256 bLiquidationPrice
    ) internal pure returns (bool) {
        _requirePositionSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return aLiquidationPrice >= bLiquidationPrice;
        }

        return aLiquidationPrice <= bLiquidationPrice;
    }

    function _referenceComesBefore(
        FuturesTypes.PositionSide side,
        uint256 aReferencePrice,
        uint256 bReferencePrice
    ) internal pure returns (bool) {
        _requirePositionSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return aReferencePrice > bReferencePrice;
        }

        return aReferencePrice < bReferencePrice;
    }

    function _referenceDoesNotComeAfter(
        FuturesTypes.PositionSide side,
        uint256 aReferencePrice,
        uint256 bReferencePrice
    ) internal pure returns (bool) {
        _requirePositionSide(side);

        if (side == FuturesTypes.PositionSide.Long) {
            return aReferencePrice >= bReferencePrice;
        }

        return aReferencePrice <= bReferencePrice;
    }

    function _requirePositionSide(FuturesTypes.PositionSide side) internal pure {
        if (side != FuturesTypes.PositionSide.Long && side != FuturesTypes.PositionSide.Short) {
            revert InvalidPositionSide();
        }
    }

}
