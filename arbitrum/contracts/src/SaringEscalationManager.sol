// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "saring-wormhole/SaringWormhole.sol";

/// UMA Optimistic Oracle V3 EscalationManagerInterface (UMAprotocol/protocol,
/// packages/core/contracts/optimistic-oracle-v3/interfaces/EscalationManagerInterface.sol).
interface EscalationManagerInterface {
    struct AssertionPolicy {
        bool blockAssertion;
        bool arbitrateViaEscalationManager;
        bool discardOracle;
        bool validateDisputers;
    }
    function getAssertionPolicy(bytes32 assertionId) external view returns (AssertionPolicy memory);
    function isDisputeAllowed(bytes32 assertionId, address disputeCaller) external view returns (bool);
    function getPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external returns (int256);
    function requestPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external;
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external;
    function assertionDisputedCallback(bytes32 assertionId) external;
}

interface IOptimisticOracleV3Stamp {
    /// Ancillary data OOv3 passes to the oracle: "assertionId:<hex>,ooAsserter:<hex>".
    function stampAssertion(bytes32 assertionId) external view returns (bytes memory);
}

/// @title SaringEscalationManager
/// @notice Unplugs UMA's DVM for assertions that name this contract as escalation manager:
///         a disputed assertion is decided by a Saring court (conflict-blind jury on Solana),
///         delivered either as a Wormhole VAA (resolveWithVaa: guardian-attested Solana state, no Saring key)
///         or as the legacy EIP-712 Verdict signed by the Saring relayer (resolve).
///         YES majority => price 1e18 (assertion true). NO, tie or incomplete => 0 (false).
contract SaringEscalationManager is EscalationManagerInterface, SaringWormhole {

    struct Request {
        bytes32 identifier;
        uint256 time;
        bytes32 assertionId;
        bool resolved;
        int256 price;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 court,uint8 yes,uint8 no,uint8 excluded,bool incomplete,uint64 resolvedSlot)"
    );
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    int256 public constant NUMERICAL_TRUE = 1e18;

    address public immutable oo;
    address public immutable relayer;
    address public immutable owner; // Saring operator: binds a court to each disputed assertion
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => bytes32) public courtOf;   // assertionId => Saring court
    mapping(bytes32 => Request) public requests;  // keccak256(ancillaryData) => request

    event CourtBound(bytes32 indexed assertionId, bytes32 indexed court);
    event PriceRequested(bytes32 indexed assertionId, bytes32 identifier, uint256 time);
    event Ruled(bytes32 indexed assertionId, bytes32 indexed court, int256 price, uint8 yes, uint8 no, uint8 excluded, bool incomplete, uint64 resolvedSlot);

    error OnlyOracle();
    error OnlyOwner();
    error AlreadyBound();
    error WrongCourt();
    error NotRequested();
    error AlreadyResolved();
    error NotResolved();
    error BadSignature();

    constructor(address oo_, address relayer_, IWormhole wormhole_, bytes32 emitter_) SaringWormhole(wormhole_, emitter_) {
        oo = oo_;
        relayer = relayer_;
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SaringEscalationManager"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------- OOv3 hooks ----------------

    function getAssertionPolicy(bytes32) external pure returns (AssertionPolicy memory) {
        // Every dispute goes to Saring instead of the DVM; the oracle result is respected; anyone may dispute.
        return AssertionPolicy({blockAssertion: false, arbitrateViaEscalationManager: true, discardOracle: false, validateDisputers: false});
    }

    function isDisputeAllowed(bytes32, address) external pure returns (bool) {
        return true;
    }

    function requestPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external {
        if (msg.sender != oo) revert OnlyOracle();
        bytes32 assertionId = _assertionIdFrom(ancillaryData);
        requests[keccak256(ancillaryData)] = Request(identifier, time, assertionId, false, 0);
        emit PriceRequested(assertionId, identifier, time);
    }

    /// OOv3 calls this via its `view` _oracleGetPrice, i.e. STATICCALL: must not write state.
    function getPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external view returns (int256) {
        Request storage r = requests[keccak256(ancillaryData)];
        if (!r.resolved || r.identifier != identifier || r.time != time) revert NotResolved();
        return r.price;
    }

    function assertionResolvedCallback(bytes32, bool) external {}
    function assertionDisputedCallback(bytes32) external {}

    // ---------------- Saring ----------------

    function bindCourt(bytes32 assertionId, bytes32 court) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (courtOf[assertionId] != bytes32(0)) revert AlreadyBound();
        courtOf[assertionId] = court;
        emit CourtBound(assertionId, court);
    }

    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VERDICT_TYPEHASH, v.court, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// Anyone may submit; only the relayer's signature over the bound court's verdict counts.
    function resolve(bytes32 assertionId, Verdict calldata v, uint8 sigV, bytes32 r, bytes32 s) external {
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(verdictDigest(v), sigV, r, s);
        if (signer == address(0) || signer != relayer) revert BadSignature();
        _rule(assertionId, v);
    }

    /// Anyone may submit a Wormhole VAA of the bound court's verdict, posted on Solana by saring_wormhole.
    function resolveWithVaa(bytes32 assertionId, bytes calldata vaa) external {
        _rule(assertionId, verdictFromVaa(vaa));
    }

    function _rule(bytes32 assertionId, Verdict memory v) internal {
        if (courtOf[assertionId] == bytes32(0) || courtOf[assertionId] != v.court) revert WrongCourt();
        Request storage req = requests[keccak256(IOptimisticOracleV3Stamp(oo).stampAssertion(assertionId))];
        if (req.assertionId != assertionId) revert NotRequested();
        if (req.resolved) revert AlreadyResolved();

        int256 price = (!v.incomplete && v.yes > v.no) ? NUMERICAL_TRUE : int256(0);
        req.resolved = true;
        req.price = price;
        emit Ruled(assertionId, v.court, price, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot);
    }

    /// Parses "assertionId:<64 lowercase hex>,..." (UMA AncillaryData.appendKeyValueBytes32 format).
    function _assertionIdFrom(bytes memory a) internal pure returns (bytes32 id) {
        bytes memory prefix = "assertionId:";
        if (a.length < 76) revert NotRequested();
        for (uint256 i = 0; i < 12; i++) if (a[i] != prefix[i]) revert NotRequested();
        uint256 x;
        for (uint256 i = 12; i < 76; i++) {
            uint8 c = uint8(a[i]);
            uint256 d;
            if (c >= 48 && c <= 57) d = c - 48;
            else if (c >= 97 && c <= 102) d = c - 87;
            else revert NotRequested();
            x = (x << 4) | d;
        }
        id = bytes32(x);
    }
}
