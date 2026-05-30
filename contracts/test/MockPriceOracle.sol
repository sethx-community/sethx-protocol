// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockPriceOracle {
    uint256 private _price;
    uint256 private _timestamp;
    uint256 private _lastFetchTimestamp;
    uint8 private immutable _decimals;

    string private _status;
    string private _pair;
    string private _source;
    string private _notes;
    string private _fetchFormula;

    mapping(address => uint256) private _fundingBalances;

    constructor(string memory pair_, uint8 decimals_, uint256 initialPrice_) {
        _pair = pair_;
        _decimals = decimals_;
        _price = initialPrice_;
        _timestamp = block.timestamp;
        _lastFetchTimestamp = block.timestamp;
        _status = "OK";
        _source = "MockPriceOracle";
        _notes = "Local test oracle";
        _fetchFormula = "Mock oracle: price is manually set through setPrice() or setPriceWithTimestamp(); fetchPrice() records lastFetchTimestamp and does not call an external feed.";
    }

    function setPrice(uint256 newPrice) external {
        _price = newPrice;
        _timestamp = block.timestamp;
        _lastFetchTimestamp = block.timestamp;
        _status = "OK";
    }

    function setPriceWithTimestamp(
        uint256 newPrice,
        uint256 timestamp_,
        uint256 lastFetchTimestamp_,
        string calldata status_
    ) external {
        _price = newPrice;
        _timestamp = timestamp_;
        _lastFetchTimestamp = lastFetchTimestamp_;
        _status = status_;
    }

    function setMetadata(
        string calldata pair_,
        string calldata source_,
        string calldata notes_
    ) external {
        _pair = pair_;
        _source = source_;
        _notes = notes_;
    }

    function setFetchFormula(string calldata fetchFormula_) external {
        _fetchFormula = fetchFormula_;
    }

    function getLastPrice()
        external
        view
        returns (uint256 price, uint256 timestamp, uint256 lastFetchTimestamp, string memory status)
    {
        return (_price, _timestamp, _lastFetchTimestamp, _status);
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function fetchPrice() external {
        _lastFetchTimestamp = block.timestamp;
    }

    function fetchFormula() external view returns (string memory) {
        return _fetchFormula;
    }

    function metadata()
        external
        view
        returns (string memory pair, string memory source, string memory notes)
    {
        return (_pair, _source, _notes);
    }

    function depositFundingToken(address token, uint256 amount) external {
        _fundingBalances[token] += amount;
    }

    function withdrawFundingToken(address token, address, uint256 amount) external {
        require(_fundingBalances[token] >= amount, "insufficient funding");
        _fundingBalances[token] -= amount;
    }

    function fundingTokenBalance(address token) external view returns (uint256) {
        return _fundingBalances[token];
    }
}
