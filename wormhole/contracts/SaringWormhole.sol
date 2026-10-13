// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Wormhole core bridge (wormhole-foundation/wormhole, ethereum/contracts/interfaces/IWormhole.sol), the subset we call.
interface IWormhole {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint8 guardianIndex;
    }
    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        Signature[] signatures;
        bytes32 hash;
    }
    function parseAndVerifyVM(bytes calldata encodedVM) external view returns (VM memory vm, bool valid, string memory reason);
}

/// @title SaringWormhole
/// @notice Shared by the Saring EVM adapters (arbitrum/, base/, tempo/, ethereum Sepolia): the Verdict they
///         settle on, decodable from a Wormhole VAA instead of a relayer signature. The VAA must be signed by
///         the current guardian set (checked by the chain's Wormhole core bridge) and emitted on Solana by the
///         saring_wormhole program's PDA, which only posts what it read from a resolved CourtAccount owned by
///         the Saring program (wormhole/program/src/lib.rs). No Saring-held key is involved.
abstract contract SaringWormhole {
    struct Verdict {
        bytes32 court;        // Saring court account pubkey (Solana, 32 bytes)
        uint8 yes;
        uint8 no;
        uint8 excluded;       // ballots dropped inside MPC (juror holds a position)
        bool incomplete;      // conflict check overflowed => void
        uint64 resolvedSlot;  // Solana slot at which the resolved court was read
    }

    uint16 public constant SOLANA_CHAIN_ID = 1; // Wormhole chain id (devnet and mainnet alike)
    IWormhole public immutable wormhole;
    bytes32 public immutable saringEmitter; // saring_wormhole PDA ["emitter"] on Solana

    error BadVaa(string reason);
    error WrongEmitter();
    error BadPayload();
    error RelayerWithVaa();

    constructor(IWormhole wormhole_, bytes32 emitter_) {
        wormhole = wormhole_;
        saringEmitter = emitter_;
    }

    /// A deployment that verifies VAAs must not also trust a relayer key: that key could sign any tally for a
    /// bound court before it resolves and front-run the VAA (security review 2026-10-13, finding 1). The legacy
    /// EIP-712 path therefore exists only on deployments without a Wormhole core.
    function _requireVaaOnly(IWormhole wormhole_, address relayer_) internal pure {
        if (address(wormhole_) != address(0) && relayer_ != address(0)) revert RelayerWithVaa();
    }

    /// Payload (45 bytes): 0x01 | court[32] | yes | no | excluded | incomplete | slot u64 BE.
    function verdictFromVaa(bytes calldata vaa) public view returns (Verdict memory v) {
        (IWormhole.VM memory m, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        if (!valid) revert BadVaa(reason);
        if (m.emitterChainId != SOLANA_CHAIN_ID || m.emitterAddress != saringEmitter) revert WrongEmitter();
        bytes memory p = m.payload;
        if (p.length != 45 || p[0] != 0x01) revert BadPayload();
        bytes32 court;
        uint64 slot;
        assembly {
            court := mload(add(p, 33))
            slot := shr(192, mload(add(p, 69)))
        }
        v = Verdict(court, uint8(p[33]), uint8(p[34]), uint8(p[35]), p[36] != 0, slot);
    }
}
