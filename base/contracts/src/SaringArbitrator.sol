// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The Reality.eth v3 calls an arbitrator makes (RealityETH-3.0.sol).
interface IRealityETH {
    function notifyOfArbitrationRequest(bytes32 question_id, address requester, uint256 max_previous) external;
    function assignWinnerAndSubmitAnswerByArbitrator(
        bytes32 question_id,
        bytes32 answer,
        address payee_if_wrong,
        bytes32 last_history_hash,
        bytes32 last_answer_or_commitment_id,
        address last_answerer
    ) external;
}

/// @title SaringArbitrator
/// @notice A Reality.eth v3 arbitrator (the slot Kleros fills for Seer/Precog) whose rulings are
///         Saring court verdicts: the same EIP-712 Verdict attestation SaringMarket uses on Tempo.
///         YES majority => answer 1, NO majority => 0, tie or incomplete => INVALID (0xff..ff).
contract SaringArbitrator {
    struct Verdict {
        bytes32 court;        // Saring court account pubkey (Solana, 32 bytes)
        uint8 yes;
        uint8 no;
        uint8 excluded;       // ballots dropped inside MPC (juror holds a position)
        bool incomplete;      // conflict check overflowed => void
        uint64 resolvedSlot;  // Solana slot at which the relayer read the resolved court
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 court,uint8 yes,uint8 no,uint8 excluded,bool incomplete,uint64 resolvedSlot)"
    );
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes32 public constant INVALID = bytes32(type(uint256).max);

    IRealityETH public immutable realitio;
    address public immutable relayer;
    address public immutable owner; // Saring operator: sets the fee, binds a court to each dispute
    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 public disputeFee;

    mapping(bytes32 => address) public requester; // question => who paid for arbitration
    mapping(bytes32 => bytes32) public courtOf;   // question => Saring court
    mapping(bytes32 => bool) public ruled;

    event ArbitrationRequested(bytes32 indexed questionId, address indexed requester, uint256 fee);
    event CourtBound(bytes32 indexed questionId, bytes32 indexed court);
    event Ruled(bytes32 indexed questionId, bytes32 indexed court, bytes32 answer); // tally is in the signed calldata

    error OnlyOwner();
    error FeeTooLow();
    error AlreadyRequested();
    error NotRequested();
    error AlreadyBound();
    error WrongCourt();
    error AlreadyRuled();
    error BadSignature();

    constructor(IRealityETH realitio_, address relayer_, uint256 fee_) {
        realitio = realitio_;
        relayer = relayer_;
        owner = msg.sender;
        disputeFee = fee_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SaringArbitrator"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// Same getter name Reality.eth's reference Arbitrator and UIs use.
    function getDisputeFee(bytes32) external view returns (uint256) {
        return disputeFee;
    }

    function setDisputeFee(uint256 fee) external {
        if (msg.sender != owner) revert OnlyOwner();
        disputeFee = fee;
    }

    /// Pay the fee to freeze the question; Reality.eth checks it is open, answered and the bond didn't move.
    function requestArbitration(bytes32 questionId, uint256 maxPrevious) external payable returns (bool) {
        if (msg.value < disputeFee) revert FeeTooLow();
        if (requester[questionId] != address(0)) revert AlreadyRequested();
        requester[questionId] = msg.sender;
        realitio.notifyOfArbitrationRequest(questionId, msg.sender, maxPrevious);
        emit ArbitrationRequested(questionId, msg.sender, msg.value);
        return true;
    }

    function bindCourt(bytes32 questionId, bytes32 court) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (courtOf[questionId] != bytes32(0)) revert AlreadyBound();
        courtOf[questionId] = court;
        emit CourtBound(questionId, court);
    }

    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VERDICT_TYPEHASH, v.court, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function answerFor(Verdict calldata v) public pure returns (bytes32) {
        if (v.incomplete || v.yes == v.no) return INVALID;
        return v.yes > v.no ? bytes32(uint256(1)) : bytes32(0);
    }

    /// Anyone may submit; only the relayer's signature over the bound court's verdict counts.
    /// last* = the question's latest history entry (from LogNewAnswer), as Reality.eth requires.
    function rule(
        bytes32 questionId,
        Verdict calldata v,
        uint8 sigV,
        bytes32 r,
        bytes32 s,
        bytes32 lastHistoryHash,
        bytes32 lastAnswer,
        address lastAnswerer
    ) external {
        if (requester[questionId] == address(0)) revert NotRequested();
        if (ruled[questionId]) revert AlreadyRuled();
        if (courtOf[questionId] == bytes32(0) || courtOf[questionId] != v.court) revert WrongCourt();
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(verdictDigest(v), sigV, r, s);
        if (signer == address(0) || signer != relayer) revert BadSignature();

        ruled[questionId] = true;
        bytes32 answer = answerFor(v);
        // Reality.eth credits the last answerer if they were right, else the requester who paid us.
        realitio.assignWinnerAndSubmitAnswerByArbitrator(questionId, answer, requester[questionId], lastHistoryHash, lastAnswer, lastAnswerer);
        emit Ruled(questionId, v.court, answer);
    }

    function withdraw() external {
        if (msg.sender != owner) revert OnlyOwner();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok);
    }
}
