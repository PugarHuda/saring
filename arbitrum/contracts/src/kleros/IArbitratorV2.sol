// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// Vendored from kleros/kleros-v2 (dev), contracts/src/arbitration/interfaces/{IArbitratorV2,IArbitrableV2}.sol:
// same events and function signatures; both interfaces in one file, NatSpec trimmed, and the OpenZeppelin IERC20
// import replaced by the empty interface below (the interface only uses it as a type; ABI-wise it is an address).
interface IERC20 {}

interface IArbitrableV2 {
    event DisputeRequest(IArbitratorV2 indexed _arbitrator, uint256 indexed _arbitratorDisputeID, uint256 _templateId);
    event Ruling(IArbitratorV2 indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling);

    function rule(uint256 _disputeID, uint256 _ruling) external;
}

interface IArbitratorV2 {
    event DisputeCreation(uint256 indexed _disputeID, IArbitrableV2 indexed _arbitrable);
    event Ruling(IArbitrableV2 indexed _arbitrable, uint256 indexed _disputeID, uint256 _ruling);
    event RulingExecuted(IArbitrableV2 indexed _arbitrable, uint256 indexed _disputeID, uint256 _ruling);
    event AcceptedFeeToken(IERC20 indexed _token, bool indexed _accepted);

    function createDispute(uint256 _numberOfChoices, bytes calldata _extraData) external payable returns (uint256 disputeID);
    function createDispute(uint256 _numberOfChoices, bytes calldata _extraData, IERC20 _feeToken, uint256 _feeAmount) external returns (uint256 disputeID);
    function arbitrationCost(bytes calldata _extraData) external view returns (uint256 cost);
    function arbitrationCost(bytes calldata _extraData, IERC20 _feeToken) external view returns (uint256 cost);
    function currentRuling(uint256 _disputeID) external view returns (uint256 ruling, bool tied, bool overridden);
}
