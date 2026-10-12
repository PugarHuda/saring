// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "saring-wormhole/SaringWormhole.sol";

/// nitro-devnode stand-in for the Wormhole core bridge: parses a real VAA's body but does NOT check guardian
/// signatures (no guardian set exists on a local devnode). Used only to exercise arbitrum/stylus locally;
/// on Arbitrum Sepolia the verifier points at the real core 0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35.
contract ParseOnlyWormhole {
    function parseAndVerifyVM(bytes calldata v) external pure returns (IWormhole.VM memory m, bool valid, string memory reason) {
        uint256 body = 6 + 66 * uint8(v[5]); // version u8 | guardianSetIndex u32 | nSigs u8 | sigs[66]
        m.version = uint8(v[0]);
        m.guardianSetIndex = uint32(bytes4(v[1:5]));
        m.timestamp = uint32(bytes4(v[body:body + 4]));
        m.nonce = uint32(bytes4(v[body + 4:body + 8]));
        m.emitterChainId = uint16(bytes2(v[body + 8:body + 10]));
        m.emitterAddress = bytes32(v[body + 10:body + 42]);
        m.sequence = uint64(bytes8(v[body + 42:body + 50]));
        m.consistencyLevel = uint8(v[body + 50]);
        m.payload = v[body + 51:];
        m.hash = keccak256(abi.encodePacked(keccak256(v[body:])));
        return (m, true, "");
    }
}
