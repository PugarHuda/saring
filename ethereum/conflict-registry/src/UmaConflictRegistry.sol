// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UmaConflictRegistry
/// @notice On-chain commitment to Saring's UMA Conflict Report: for every UMA DVM dispute of a Polymarket market,
///         the set of voters whose Polymarket wallet held a position in that market when they voted.
///         The report is published as one Merkle root; anyone (a contract, a UI, a court) can check a single
///         (dispute, voter) pair with a proof and no trust in Saring's servers.
/// @dev    disputeId is UMA VotingV2's own price-request id: keccak256(abi.encode(identifier, time, ancillaryData)),
///         i.e. the key of VotingV2.priceRequests on Ethereum mainnet (0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac).
///         Leaves follow OpenZeppelin's StandardMerkleTree: keccak256(bytes.concat(keccak256(abi.encode(disputeId, voter)))),
///         internal nodes hash the sorted pair. Proofs come from data/proofs.json (built by script/build-merkle.ts).
contract UmaConflictRegistry {
    /// @notice UMA VotingV2 on Ethereum mainnet (the DVM whose votes the report covers). Informational.
    address public constant UMA_VOTING_V2_MAINNET = 0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac;

    address public owner;
    bytes32 public root;
    /// @notice sha256 of the conflicts.csv file the root was built from (lets anyone re-derive the tree).
    bytes32 public datasetHash;
    uint64 public leafCount;
    uint64 public disputeCount;
    uint64 public updatedAt;
    uint32 public version;
    string public datasetURI;

    event ReportPublished(
        uint32 indexed version, bytes32 indexed root, bytes32 datasetHash, uint64 leafCount, uint64 disputeCount, string datasetURI
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 root_, bytes32 datasetHash_, uint64 leafCount_, uint64 disputeCount_, string memory uri_) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _publish(root_, datasetHash_, leafCount_, disputeCount_, uri_);
    }

    /// @notice Publish a new report (the daily monitor appends disputes, so the root changes).
    function publish(bytes32 root_, bytes32 datasetHash_, uint64 leafCount_, uint64 disputeCount_, string calldata uri_)
        external
        onlyOwner
    {
        _publish(root_, datasetHash_, leafCount_, disputeCount_, uri_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice True iff `voter` is in the conflicted-voter set of `disputeId` in the current report.
    function isConflicted(bytes32 disputeId, address voter, bytes32[] calldata proof) public view returns (bool) {
        return _verify(proof, root, leaf(disputeId, voter));
    }

    /// @notice Same check keyed by the raw UMA request (as seen in VotingV2 / OptimisticOracle events).
    function isConflictedRequest(
        bytes32 identifier,
        uint256 time,
        bytes calldata ancillaryData,
        address voter,
        bytes32[] calldata proof
    ) external view returns (bool) {
        return isConflicted(disputeIdOf(identifier, time, ancillaryData), voter, proof);
    }

    /// @notice UMA VotingV2 price-request id (VotingV2._encodePriceRequest).
    function disputeIdOf(bytes32 identifier, uint256 time, bytes calldata ancillaryData) public pure returns (bytes32) {
        return keccak256(abi.encode(identifier, time, ancillaryData));
    }

    function leaf(bytes32 disputeId, address voter) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(disputeId, voter))));
    }

    function _publish(bytes32 root_, bytes32 datasetHash_, uint64 leafCount_, uint64 disputeCount_, string memory uri_)
        internal
    {
        root = root_;
        datasetHash = datasetHash_;
        leafCount = leafCount_;
        disputeCount = disputeCount_;
        datasetURI = uri_;
        updatedAt = uint64(block.timestamp);
        version += 1;
        emit ReportPublished(version, root_, datasetHash_, leafCount_, disputeCount_, uri_);
    }

    /// @dev OpenZeppelin MerkleProof.verify semantics (commutative keccak of sorted pairs), inlined to stay dependency-free.
    function _verify(bytes32[] calldata proof, bytes32 root_, bytes32 node) internal pure returns (bool) {
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encode(node, p)) : keccak256(abi.encode(p, node));
        }
        return node == root_;
    }
}
