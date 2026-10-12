// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./kleros/IArbitratorV2.sol";

/// @title SaringEscrow
/// @notice Minimal IArbitrableV2: a payer locks ETH for a payee. The payer may release; either party may
///         dispute by paying the arbitrator's fee. The question to the court: "did the payee deliver?"
///         Ruling 1 (YES) pays the payee, 2 (NO) refunds the payer, 0 (refused) splits it in half.
contract SaringEscrow is IArbitrableV2 {
    struct Deal {
        address payer;
        address payee;
        uint256 amount;
        uint256 disputeID;
        bool disputed;
        bool closed;
    }

    IArbitratorV2 public immutable arbitrator;
    Deal[] public deals;
    mapping(uint256 => uint256) public dealOfDispute; // arbitrator disputeID => deal id

    event DealOpened(uint256 indexed dealId, address indexed payer, address indexed payee, uint256 amount);
    event DealClosed(uint256 indexed dealId, uint256 toPayee, uint256 toPayer);

    error NotParty();
    error Closed();
    error OnlyArbitrator();
    error UnknownDispute();
    error TransferFailed();

    constructor(IArbitratorV2 arbitrator_) {
        arbitrator = arbitrator_;
    }

    function open(address payee) external payable returns (uint256 id) {
        id = deals.length;
        deals.push(Deal(msg.sender, payee, msg.value, 0, false, false));
        emit DealOpened(id, msg.sender, payee, msg.value);
    }

    function release(uint256 id) external {
        Deal storage d = deals[id];
        if (msg.sender != d.payer) revert NotParty();
        if (d.closed || d.disputed) revert Closed();
        _close(id, d.amount, 0);
    }

    /// msg.value must cover arbitrator.arbitrationCost(""); the arbitrator keeps it.
    function dispute(uint256 id) external payable returns (uint256 disputeID) {
        Deal storage d = deals[id];
        if (msg.sender != d.payer && msg.sender != d.payee) revert NotParty();
        if (d.closed || d.disputed) revert Closed();
        d.disputed = true;
        disputeID = arbitrator.createDispute{value: msg.value}(2, "");
        d.disputeID = disputeID;
        dealOfDispute[disputeID] = id;
        emit DisputeRequest(arbitrator, disputeID, 0);
    }

    function rule(uint256 _disputeID, uint256 _ruling) external {
        if (msg.sender != address(arbitrator)) revert OnlyArbitrator();
        uint256 id = dealOfDispute[_disputeID];
        if (id >= deals.length) revert UnknownDispute();
        Deal storage d = deals[id];
        if (!d.disputed || d.disputeID != _disputeID) revert UnknownDispute();
        if (d.closed) revert Closed();
        emit Ruling(arbitrator, _disputeID, _ruling);
        uint256 toPayee = _ruling == 1 ? d.amount : _ruling == 2 ? 0 : d.amount / 2;
        _close(id, toPayee, d.amount - toPayee);
    }

    function _close(uint256 id, uint256 toPayee, uint256 toPayer) internal {
        Deal storage d = deals[id];
        d.closed = true;
        emit DealClosed(id, toPayee, toPayer);
        if (toPayee > 0) {
            (bool a,) = d.payee.call{value: toPayee}("");
            if (!a) revert TransferFailed();
        }
        if (toPayer > 0) {
            (bool b,) = d.payer.call{value: toPayer}("");
            if (!b) revert TransferFailed();
        }
    }
}
