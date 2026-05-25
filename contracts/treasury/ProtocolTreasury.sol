// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./TreasuryAuthority.sol";

/**
 * @title ProtocolTreasury
 * @notice Canonical custody contract for protocol-owned assets.
 *
 * Responsibilities:
 * - receive ETH/ERC20 withdrawn from SethxVault
 * - hold protocol-owned ETH, SETHX, and other approved ERC20 assets
 * - fund approved internal receivers such as treasury-owned execution accounts
 * - pay approved external recipients
 * - expose a simple asset overview for frontend integrations
 * - allow approved treasury modules to execute treasury actions
 */
contract ProtocolTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Address for address payable;

    TreasuryAuthority public immutable authority;

    mapping(address => bool) public approvedExternalRecipients;
    mapping(address => bool) public approvedInternalReceivers;
    mapping(address => bool) public approvedTokens;
    mapping(address => bool) public approvedTreasuryModules;

    mapping(address => bool) private _trackedTokens;
    address[] private _tokenList;

    event ApprovedExternalRecipientUpdated(address indexed recipient, bool allowed);
    event ApprovedInternalReceiverUpdated(address indexed receiver, bool allowed);
    event ApprovedTokenUpdated(address indexed token, bool allowed);
    event ApprovedTreasuryModuleUpdated(address indexed module, bool allowed);

    event TreasuryETHReceived(address indexed from, uint256 amount);
    event TreasuryERC20Tracked(address indexed token);

    event ETHInternalFunding(address indexed caller, address indexed receiver, uint256 amount);
    event ERC20InternalFunding(
        address indexed caller,
        address indexed token,
        address indexed receiver,
        uint256 amount
    );

    event ETHPayment(address indexed caller, address indexed recipient, uint256 amount);
    event ERC20Payment(
        address indexed caller,
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error TokenNotApproved();
    error ExternalRecipientNotApproved();
    error InternalReceiverNotApproved();
    error TreasuryModuleNotApproved();

    constructor(address authority_) {
        if (authority_ == address(0)) revert InvalidAddress();

        authority = TreasuryAuthority(authority_);
    }

    receive() external payable {
        emit TreasuryETHReceived(msg.sender, msg.value);
    }

    modifier onlyGovernor() {
        if (!authority.hasRole(authority.GOVERNOR_ROLE(), msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyApprovedTreasuryModule() {
        if (!approvedTreasuryModules[msg.sender]) revert TreasuryModuleNotApproved();
        _;
    }

    function setApprovedExternalRecipient(address recipient, bool allowed) external onlyGovernor {
        if (recipient == address(0)) revert InvalidAddress();

        approvedExternalRecipients[recipient] = allowed;
        emit ApprovedExternalRecipientUpdated(recipient, allowed);
    }

    function setApprovedInternalReceiver(address receiver, bool allowed) external onlyGovernor {
        if (receiver == address(0)) revert InvalidAddress();

        approvedInternalReceivers[receiver] = allowed;
        emit ApprovedInternalReceiverUpdated(receiver, allowed);
    }

    function setApprovedToken(address token, bool allowed) external onlyGovernor {
        if (token == address(0)) revert InvalidAddress();

        approvedTokens[token] = allowed;
        if (allowed) {
            _trackToken(token);
        }

        emit ApprovedTokenUpdated(token, allowed);
    }

    function setApprovedTreasuryModule(address module, bool allowed) external onlyGovernor {
        if (module == address(0)) revert InvalidAddress();

        approvedTreasuryModules[module] = allowed;
        emit ApprovedTreasuryModuleUpdated(module, allowed);
    }

    function fundInternalETH(
        address payable receiver,
        uint256 amount
    ) external onlyApprovedTreasuryModule nonReentrant {
        if (receiver == payable(address(0))) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (!approvedInternalReceivers[receiver]) revert InternalReceiverNotApproved();

        receiver.sendValue(amount);
        emit ETHInternalFunding(msg.sender, receiver, amount);
    }

    function fundInternalERC20(
        address token,
        address receiver,
        uint256 amount
    ) external onlyApprovedTreasuryModule nonReentrant {
        if (token == address(0) || receiver == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (!approvedTokens[token]) revert TokenNotApproved();
        if (!approvedInternalReceivers[receiver]) revert InternalReceiverNotApproved();

        _trackToken(token);
        IERC20(token).safeTransfer(receiver, amount);

        emit ERC20InternalFunding(msg.sender, token, receiver, amount);
    }

    function payETH(
        address payable recipient,
        uint256 amount
    ) external onlyApprovedTreasuryModule nonReentrant {
        if (recipient == payable(address(0))) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (!approvedExternalRecipients[recipient]) revert ExternalRecipientNotApproved();

        recipient.sendValue(amount);
        emit ETHPayment(msg.sender, recipient, amount);
    }

    function payERC20(
        address token,
        address recipient,
        uint256 amount
    ) external onlyApprovedTreasuryModule nonReentrant {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (!approvedTokens[token]) revert TokenNotApproved();
        if (!approvedExternalRecipients[recipient]) revert ExternalRecipientNotApproved();

        _trackToken(token);
        IERC20(token).safeTransfer(recipient, amount);

        emit ERC20Payment(msg.sender, token, recipient, amount);
    }

    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function tokenBalance(address token) public view returns (uint256) {
        if (token == address(0)) revert InvalidAddress();
        return IERC20(token).balanceOf(address(this));
    }

    function isTrackedToken(address token) external view returns (bool) {
        return _trackedTokens[token];
    }

    function getTrackedTokens() external view returns (address[] memory) {
        return _tokenList;
    }

    function getAssetOverview()
        external
        view
        returns (uint256 ethBal, address[] memory tokens, uint256[] memory balances)
    {
        ethBal = address(this).balance;
        tokens = _tokenList;
        balances = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    function _trackToken(address token) internal {
        if (!_trackedTokens[token]) {
            _trackedTokens[token] = true;
            _tokenList.push(token);
            emit TreasuryERC20Tracked(token);
        }
    }
}
