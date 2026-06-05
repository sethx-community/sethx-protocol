// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

library FuturesTypes {
    enum PositionSide {
        None,
        Long,
        Short
    }

    struct MarketConfig {
        string ticker;
        address oracle;
        uint8 oraclePriceDecimals;
        uint8 marginDecimals;
        uint256 initialMarginBps;
        uint256 maintenanceMarginBps;
        uint256 multiplier;
        uint256 lastSettlementPrice;
        uint256 lastSettlementBlock;
        uint256 lastSettlementTimestamp;
    }

    struct Position {
        PositionSide side;
        uint256 size;
        uint256 margin;
        uint256 referencePrice;
        uint256 liquidationPrice;
        uint256 liquidationTick;
        uint256 lossIndexSnapshot;
    }

    struct LiquidationList {
        address head;
        address tail;
        uint256 count;
    }

    struct LiquidationNode {
        bool active;
        PositionSide side;
        uint256 liquidationPrice;
        uint256 liquidationTick;
        address prev;
        address next;
    }

    struct ReferencePriceList {
        address head;
        address tail;
        uint256 count;
    }

    struct ReferencePriceNode {
        bool active;
        PositionSide side;
        uint256 referencePrice;
        uint256 referenceTick;
        address prev;
        address next;
    }
}
