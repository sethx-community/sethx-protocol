// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { PriceManager } from "../../oracle/PriceManager.sol";
import { LendingContract } from "./LendingContract.sol";
import { SethxVault } from "../../vault/SethxVault.sol";
import { OptionsValuationAdapter } from "./OptionsValuationAdapter.sol";
import { FuturesValuationAdapter } from "./FuturesValuationAdapter.sol";

interface ILiquidationAuctionValuationView {
    function getCurrentAuctionPrice(address account) external view returns (uint256);
}

contract ValuationModule is AccessControl {
    uint256 public constant BPS = 10_000;
    uint256 public constant RAY = 1e27;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");

    // -------- Errors --------
    error ZeroAddress();
    error InvalidRiskLevel();
    error InvalidLtvConfig();
    error InvalidHaircut();
    error RiskTierDisabled();

    struct RiskTier {
        bool enabled;
        uint32 maxLtvBps;
        uint32 liquidationLtvBps;
        uint16 longOptionHaircutBps;
        uint16 shortOptionHaircutBps;
        uint16 bondHaircutBps;
        uint16 futuresHaircutStepBps;
    }

    struct AccountValues {
        uint256 collateralValueEth;
        uint256 liquidationValueEth;
        uint256 activeDebtEth;
        uint256 effectiveDebtEth;
    }

    struct Breakdown {
        uint256 freeEth;
        uint256 reservedOrderEth;
        uint256 freeErc20Eth;
        uint256 reservedOrderErc20Eth;
        uint256 longOptionsEth;
        uint256 shortOptionsEth;
        uint256 futuresEth;
        uint256 bondClaimsEth;
        uint256 nftEth;
        uint256 binaryOptionsEth;
    }

    PriceManager public immutable priceManager;
    LendingContract public immutable lendingContract;
    SethxVault public immutable vaultView;

    OptionsValuationAdapter public optionsView;
    FuturesValuationAdapter public futuresView;

    mapping(uint16 => RiskTier) public riskTiers;

    event RiskTierSet(
        uint16 indexed riskLevel,
        uint32 maxLtvBps,
        uint32 liquidationLtvBps,
        uint16 longOptionHaircutBps,
        uint16 shortOptionHaircutBps,
        uint16 bondHaircutBps,
        uint16 futuresHaircutStepBps,
        bool enabled
    );

    event OptionsViewSet(address indexed optionsView);
    event FuturesViewSet(address indexed futuresView);

    constructor(
        address _priceManager,
        address _lendingContract,
        address _vaultView,
        address admin
    ) {
        if (_priceManager == address(0)) revert ZeroAddress();
        if (_lendingContract == address(0)) revert ZeroAddress();
        if (_vaultView == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        priceManager = PriceManager(_priceManager);
        lendingContract = LendingContract(payable(_lendingContract));
        vaultView = SethxVault(_vaultView);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);

        _setRoleAdmin(RISK_ADMIN_ROLE, GOVERNOR_ROLE);
    }

    function setRiskTier(
        uint16 riskLevel,
        bool enabled,
        uint32 maxLtvBps,
        uint32 liquidationLtvBps,
        uint16 longOptionHaircutBps,
        uint16 shortOptionHaircutBps,
        uint16 bondHaircutBps,
        uint16 futuresHaircutStepBps
    ) external onlyRole(RISK_ADMIN_ROLE) {
        if (riskLevel == 0) revert InvalidRiskLevel();
        if (maxLtvBps == 0 || maxLtvBps >= liquidationLtvBps) revert InvalidLtvConfig();
        if (liquidationLtvBps > BPS) revert InvalidLtvConfig();
        if (longOptionHaircutBps > BPS) revert InvalidHaircut();
        if (shortOptionHaircutBps > BPS) revert InvalidHaircut();
        if (bondHaircutBps > BPS) revert InvalidHaircut();
        if (futuresHaircutStepBps > BPS) revert InvalidHaircut();

        riskTiers[riskLevel] = RiskTier({
            enabled: enabled,
            maxLtvBps: maxLtvBps,
            liquidationLtvBps: liquidationLtvBps,
            longOptionHaircutBps: longOptionHaircutBps,
            shortOptionHaircutBps: shortOptionHaircutBps,
            bondHaircutBps: bondHaircutBps,
            futuresHaircutStepBps: futuresHaircutStepBps
        });

        emit RiskTierSet(
            riskLevel,
            maxLtvBps,
            liquidationLtvBps,
            longOptionHaircutBps,
            shortOptionHaircutBps,
            bondHaircutBps,
            futuresHaircutStepBps,
            enabled
        );
    }

    function setOptionsView(address _optionsView) external onlyRole(GOVERNOR_ROLE) {
        optionsView = OptionsValuationAdapter(_optionsView);
        emit OptionsViewSet(_optionsView);
    }

    function setFuturesView(address _futuresView) external onlyRole(GOVERNOR_ROLE) {
        futuresView = FuturesValuationAdapter(_futuresView);
        emit FuturesViewSet(_futuresView);
    }

    function getAccountValues(
        address account,
        uint16 riskLevel
    ) external view returns (AccountValues memory values) {
        values.collateralValueEth = getCollateralValue(account, riskLevel);
        values.liquidationValueEth = getLiquidationValue(account, riskLevel);
        values.activeDebtEth = getDebtValue(account);
        values.effectiveDebtEth = getEffectiveDebtValue(account);
    }

    function getCollateralValue(address account, uint16 riskLevel) public view returns (uint256) {
        Breakdown memory b = _computeBreakdown(account, riskLevel);
        return
            b.freeEth +
            b.freeErc20Eth +
            b.longOptionsEth +
            b.shortOptionsEth +
            b.futuresEth +
            b.bondClaimsEth;
    }

    function getLiquidationValue(address account, uint16 riskLevel) public view returns (uint256) {
        Breakdown memory b = _computeBreakdown(account, riskLevel);
        return
            b.freeEth +
            b.reservedOrderEth +
            b.freeErc20Eth +
            b.reservedOrderErc20Eth +
            b.longOptionsEth +
            b.shortOptionsEth +
            b.futuresEth +
            b.bondClaimsEth;
    }

    function getDebtValue(address account) public view returns (uint256) {
        return lendingContract.getAccountTotalDebt(account);
    }

    function getEffectiveDebtValue(address account) public view returns (uint256) {
        return
            lendingContract.getAccountTotalDebt(account) +
            lendingContract.getAccountPendingBorrow(account);
    }

    function getBreakdown(
        address account,
        uint16 riskLevel
    ) external view returns (Breakdown memory) {
        return _computeBreakdown(account, riskLevel);
    }

    function getLtvAgainstCollateral(
        address account,
        uint16 riskLevel
    ) external view returns (uint256) {
        uint256 collateral = getCollateralValue(account, riskLevel);
        uint256 pendingProceeds = lendingContract.getAccountPendingBorrowProceeds(account);
        uint256 denominator = collateral + pendingProceeds;
        if (denominator == 0) return type(uint256).max;
        return (getEffectiveDebtValue(account) * BPS) / denominator;
    }

    function getLtvAgainstLiquidation(
        address account,
        uint16 riskLevel
    ) external view returns (uint256) {
        uint256 liq = getLiquidationValue(account, riskLevel);
        if (liq == 0) return type(uint256).max;
        return (getDebtValue(account) * BPS) / liq;
    }

    function canPlaceBorrowOrder(
        address account,
        uint16 riskLevel,
        uint256 additionalPrincipalEth
    ) external view returns (bool) {
        RiskTier memory tier = _getTier(riskLevel);
        uint256 collateral = getCollateralValue(account, riskLevel);
        if (collateral == 0) return false;

        uint256 pendingProceeds = lendingContract.getAccountPendingBorrowProceeds(account);
        uint256 effectiveDebt = getEffectiveDebtValue(account) + additionalPrincipalEth;
        uint256 effectiveCollateral = collateral + pendingProceeds + additionalPrincipalEth;
        return _isWithinMaxLtv(effectiveDebt, effectiveCollateral, tier.maxLtvBps);
    }

    function canPlaceRolloverBorrowOrder(
        address account,
        uint16 riskLevel,
        bytes32 repayMarketKey,
        uint256 rolloverPrincipalEth
    ) external view returns (bool) {
        RiskTier memory tier = _getTier(riskLevel);
        uint256 collateral = getCollateralValue(account, riskLevel);
        if (collateral == 0) return false;
        if (rolloverPrincipalEth == 0) return false;

        LendingContract.DebtPosition memory repayDebt = lendingContract.getDebt(
            account,
            repayMarketKey
        );
        uint256 repayFaceValue = repayDebt.faceValue;
        if (repayFaceValue == 0) return false;
        if (rolloverPrincipalEth > repayFaceValue) return false;

        uint256 effectiveDebt = getEffectiveDebtValue(account);
        uint256 pendingProceeds = lendingContract.getAccountPendingBorrowProceeds(account);
        return _isWithinMaxLtv(effectiveDebt, collateral + pendingProceeds, tier.maxLtvBps);
    }

    function canTrade(address account, uint16 riskLevel) external view returns (bool) {
        RiskTier memory tier = _getTier(riskLevel);
        uint256 collateral = getCollateralValue(account, riskLevel);
        if (collateral == 0) return false;

        uint256 pendingProceeds = lendingContract.getAccountPendingBorrowProceeds(account);
        return
            _isWithinMaxLtv(
                getEffectiveDebtValue(account),
                collateral + pendingProceeds,
                tier.maxLtvBps
            );
    }

    function canBuyAuctionedAccount(
        address buyer,
        uint16 riskLevel,
        address liquidationEngine,
        address auctionedAccount
    ) external view returns (bool) {
        if (buyer == address(0)) revert ZeroAddress();
        if (liquidationEngine == address(0)) revert ZeroAddress();
        if (auctionedAccount == address(0)) revert ZeroAddress();

        RiskTier memory tier = _getTier(riskLevel);

        uint256 purchasePriceEth = ILiquidationAuctionValuationView(liquidationEngine)
            .getCurrentAuctionPrice(auctionedAccount);

        if (purchasePriceEth == 0) return false;

        uint256 collateral = getCollateralValue(buyer, riskLevel);
        uint256 pendingProceeds = lendingContract.getAccountPendingBorrowProceeds(buyer);
        uint256 effectiveCollateral = collateral + pendingProceeds;

        if (effectiveCollateral <= purchasePriceEth) return false;

        return
            _isWithinMaxLtv(
                getEffectiveDebtValue(buyer),
                effectiveCollateral - purchasePriceEth,
                tier.maxLtvBps
            );
    }

    function isLiquidatable(address account, uint16 riskLevel) external view returns (bool) {
        RiskTier memory tier = _getTier(riskLevel);
        uint256 liqValue = getLiquidationValue(account, riskLevel);

        if (liqValue == 0) {
            return getDebtValue(account) > 0;
        }

        return (getDebtValue(account) * BPS) / liqValue > tier.liquidationLtvBps;
    }

    function _computeBreakdown(
        address account,
        uint16 riskLevel
    ) internal view returns (Breakdown memory b) {
        RiskTier memory tier = _getTier(riskLevel);

        SethxVault.EthBalancesView memory ethBalances = vaultView.getEthBalances(account);
        b.freeEth = ethBalances.freeEth;
        b.reservedOrderEth = ethBalances.reservedOrderEth;

        SethxVault.Erc20BalanceView[] memory erc20s = vaultView.getErc20Balances(account);
        PriceManager.OracleContext ctx = PriceManager.OracleContext.COLLATERAL_EVAL;

        for (uint256 i = 0; i < erc20s.length; i++) {
            SethxVault.Erc20BalanceView memory bal = erc20s[i];

            (bool ok, address oracle) = priceManager.getUsableOracleForTokenContext(bal.token, ctx);

            if (!ok) continue;

            uint256 pxEth = _oraclePriceInEth(oracle, ctx);
            if (pxEth == 0) continue;

            uint8 tokenDecimals = _tokenDecimals(bal.token);

            b.freeErc20Eth += _tokenAmountRawToEth(bal.freeAmount, pxEth, tokenDecimals);
            b.reservedOrderErc20Eth += _tokenAmountRawToEth(
                bal.reservedOrderAmount,
                pxEth,
                tokenDecimals
            );
        }

        if (address(optionsView) != address(0)) {
            OptionsValuationAdapter.OptionValue[] memory ovs = optionsView.getValuationData(
                account
            );
            for (uint256 i = 0; i < ovs.length; i++) {
                if (ovs[i].isBinary) {
                    b.binaryOptionsEth += 0;
                    continue;
                }

                b.longOptionsEth += _applyHaircut(
                    ovs[i].longIntrinsicValueEth,
                    tier.longOptionHaircutBps
                );

                b.shortOptionsEth += _applyHaircut(
                    ovs[i].shortCoveredPositiveRemainderEth,
                    tier.shortOptionHaircutBps
                );
            }
        }

        if (address(futuresView) != address(0)) {
            FuturesValuationAdapter.FuturesValue[] memory fvs = futuresView.getValuationData(
                account
            );

            for (uint256 i = 0; i < fvs.length; i++) {
                uint256 multiplier = fvs[i].multiplier;
                if (multiplier == 0) continue;

                uint256 haircutBps = _futuresHaircutBps(multiplier, tier);

                b.futuresEth += _applyHaircut(fvs[i].marginValueEth, haircutBps);
            }
        }

        uint256[] memory lots = lendingContract.getUserBondLots(account);
        for (uint256 i = 0; i < lots.length; i++) {
            LendingContract.BondLot memory lot = lendingContract.getBondLot(lots[i]);
            uint256 recoveryRate = lendingContract.getRecoveryRate(lot.marketKey);
            uint256 recoveredFace = _mulDivDown(lot.faceValue, recoveryRate, RAY);

            b.bondClaimsEth += _applyHaircut(recoveredFace, tier.bondHaircutBps);
        }

        b.nftEth = 0;
    }

    function _applyHaircut(uint256 value, uint256 haircutBps) internal pure returns (uint256) {
        if (value == 0) return 0;

        if (haircutBps >= BPS) {
            return 0;
        }

        return (value * (BPS - haircutBps)) / BPS;
    }

    function _futuresHaircutBps(
        uint256 multiplier,
        RiskTier memory tier
    ) internal pure returns (uint256 haircutBps) {
        if (multiplier == 0 || tier.futuresHaircutStepBps == 0) {
            return 0;
        }

        haircutBps = uint256(tier.futuresHaircutStepBps) * multiplier;

        if (haircutBps > BPS) {
            haircutBps = BPS;
        }
    }

    function _oraclePriceInEth(
        address oracle,
        PriceManager.OracleContext context
    ) internal view returns (uint256) {
        (uint256 rawPrice, uint8 decimals, , ) = priceManager.getOraclePrice(oracle, context);

        if (rawPrice == 0) return 0;
        if (decimals == 18) return rawPrice;
        if (decimals < 18) return rawPrice * (10 ** uint256(18 - decimals));

        return rawPrice / (10 ** uint256(decimals - 18));
    }

    function _getTier(uint16 riskLevel) internal view returns (RiskTier memory tier) {
        tier = riskTiers[riskLevel];
        if (!tier.enabled) revert RiskTierDisabled();
    }

    function _tokenDecimals(address token) internal view returns (uint8) {
        if (token == address(0)) return 18;
        return IERC20Metadata(token).decimals();
    }

    function _tokenAmountRawToEth(
        uint256 rawAmount,
        uint256 tokenPriceEthE18,
        uint8 tokenDecimals
    ) internal pure returns (uint256) {
        if (rawAmount == 0 || tokenPriceEthE18 == 0) return 0;
        return (rawAmount * tokenPriceEthE18) / (10 ** uint256(tokenDecimals));
    }

    function _isWithinMaxLtv(
        uint256 debtEth,
        uint256 collateralEth,
        uint32 maxLtvBps
    ) internal pure returns (bool) {
        if (collateralEth == 0) return false;
        return (debtEth * BPS) / collateralEth <= maxLtvBps;
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 0;
        return (a * b) / d;
    }
}
