// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "saring-wormhole/SaringWormhole.sol";
import "./kleros/IArbitratorV2.sol";

/// @title SaringArbitratorV2
/// @notice A Kleros v2 `IArbitratorV2` whose rulings come from a Saring court (conflict-blind jury on Solana),
///         delivered as a guardian-signed Wormhole VAA. An IArbitrableV2 written for KlerosCore can point here instead.
///         Binary disputes only: ruling 1 = YES, 2 = NO, 0 = refused (tie or incomplete conflict check).
contract SaringArbitratorV2 is IArbitratorV2, SaringWormhole {
    struct Dispute {
        IArbitrableV2 arbitrable;
        bytes32 court; // Saring court pubkey, bound by the operator once the court is opened on Solana
        bool ruled;
        bool tied;
        uint8 ruling;
    }

    address public immutable owner; // Saring operator: receives fees, binds courts
    uint256 public immutable cost; // flat ETH fee per dispute
    Dispute[] public disputes;

    event CourtBound(uint256 indexed disputeID, bytes32 indexed court);

    error OnlyOwner();
    error OnlyBinary();
    error InsufficientFee();
    error TokenNotAccepted();
    error UnknownDispute();
    error AlreadyBound();
    error WrongCourt();
    error AlreadyRuled();
    error FeeTransferFailed();

    constructor(IWormhole wormhole_, bytes32 emitter_, uint256 cost_) SaringWormhole(wormhole_, emitter_) {
        owner = msg.sender;
        cost = cost_;
    }

    // ---------------- IArbitratorV2 ----------------

    function createDispute(uint256 _numberOfChoices, bytes calldata) external payable returns (uint256 disputeID) {
        if (_numberOfChoices != 2) revert OnlyBinary();
        if (msg.value < cost) revert InsufficientFee();
        disputeID = disputes.length;
        disputes.push(Dispute(IArbitrableV2(msg.sender), bytes32(0), false, false, 0));
        emit DisputeCreation(disputeID, IArbitrableV2(msg.sender));
        (bool ok,) = owner.call{value: msg.value}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// ponytail: ETH fees only; ERC20 reverts as KlerosCore does for a token it has not accepted.
    function createDispute(uint256, bytes calldata, IERC20, uint256) external pure returns (uint256) {
        revert TokenNotAccepted();
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
    }

    function arbitrationCost(bytes calldata, IERC20) external pure returns (uint256) {
        revert TokenNotAccepted();
    }

    /// No appeals, so `overridden` is always false.
    function currentRuling(uint256 _disputeID) external view returns (uint256 ruling, bool tied, bool overridden) {
        Dispute storage d = _dispute(_disputeID);
        return (d.ruling, d.tied, false);
    }

    // ---------------- Saring ----------------

    function bindCourt(uint256 disputeID, bytes32 court) external {
        if (msg.sender != owner) revert OnlyOwner();
        Dispute storage d = _dispute(disputeID);
        if (d.court != bytes32(0)) revert AlreadyBound();
        d.court = court;
        emit CourtBound(disputeID, court);
    }

    /// Anyone may submit the Wormhole VAA of the bound court's verdict; the ruling is pushed to the arbitrable.
    function ruleWithVaa(uint256 disputeID, bytes calldata vaa) external {
        Dispute storage d = _dispute(disputeID);
        Verdict memory v = verdictFromVaa(vaa);
        if (d.court == bytes32(0) || d.court != v.court) revert WrongCourt();
        if (d.ruled) revert AlreadyRuled();
        uint8 ruling = v.incomplete || v.yes == v.no ? 0 : (v.yes > v.no ? 1 : 2);
        d.ruled = true;
        d.tied = !v.incomplete && v.yes == v.no;
        d.ruling = ruling;
        emit Ruling(d.arbitrable, disputeID, ruling);
        d.arbitrable.rule(disputeID, ruling);
        emit RulingExecuted(d.arbitrable, disputeID, ruling);
    }

    function disputeCount() external view returns (uint256) {
        return disputes.length;
    }

    function _dispute(uint256 id) internal view returns (Dispute storage) {
        if (id >= disputes.length) revert UnknownDispute();
        return disputes[id];
    }
}
