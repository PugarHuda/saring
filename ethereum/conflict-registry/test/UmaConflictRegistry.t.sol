// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {UmaConflictRegistry} from "../src/UmaConflictRegistry.sol";

/// Uses data/fixture.json produced by script/build-merkle.ts from the real Conflict Report:
/// root of all (disputeId, voter) conflict leaves + proofs for the report's top case studies.
contract UmaConflictRegistryTest is Test {
    using stdJson for string;

    UmaConflictRegistry reg;
    string fx;

    function setUp() public {
        fx = vm.readFile(string.concat(vm.projectRoot(), "/data/fixture.json"));
        reg = new UmaConflictRegistry(
            fx.readBytes32(".root"),
            fx.readBytes32(".datasetHash"),
            uint64(fx.readUint(".leafCount")),
            uint64(fx.readUint(".disputeCount")),
            "ipfs-or-https://pugarhuda.github.io/saring/data/conflicts.csv"
        );
    }

    function _case(uint256 i) internal view returns (bytes32 id, address voter, bytes32[] memory proof) {
        string memory k = string.concat(".cases[", vm.toString(i), "]");
        id = fx.readBytes32(string.concat(k, ".disputeId"));
        voter = fx.readAddress(string.concat(k, ".voter"));
        proof = fx.readBytes32Array(string.concat(k, ".proof"));
    }

    function test_RealCaseStudiesAreConflicted() public view {
        for (uint256 i = 0; i < 3; i++) {
            (bytes32 id, address voter, bytes32[] memory proof) = _case(i);
            assertTrue(reg.isConflicted(id, voter, proof), "case study voter must verify");
        }
    }

    /// Thailand strikes Cambodia: voter 0xacb1…6272 held 1.12M YES through its Safe and voted YES.
    function test_ThailandCaseViaRawUmaRequest() public view {
        (, address voter, bytes32[] memory proof) = _case(0);
        bytes32 identifier = fx.readBytes32(".cases[0].identifier");
        uint256 time = fx.readUint(".cases[0].time");
        bytes memory anc = fx.readBytes(".cases[0].ancillaryData");
        assertEq(voter, 0xaCB1A67A4725c7433D238DBAd292FDae839D6272);
        assertEq(identifier, bytes32("YES_OR_NO_QUERY"));
        assertEq(reg.disputeIdOf(identifier, time, anc), fx.readBytes32(".cases[0].disputeId"));
        assertTrue(reg.isConflictedRequest(identifier, time, anc, voter, proof));
    }

    function test_NonConflictedVoterRejected() public view {
        (bytes32 id,, bytes32[] memory proof) = _case(0);
        address whale = fx.readAddress(".nonConflictedVoter");
        assertFalse(reg.isConflicted(id, whale, proof));
    }

    function test_WrongDisputeRejected() public view {
        (, address voter, bytes32[] memory proof) = _case(0);
        (bytes32 otherId,,) = _case(1);
        assertFalse(reg.isConflicted(otherId, voter, proof));
    }

    function test_TamperedProofRejected() public view {
        (bytes32 id, address voter, bytes32[] memory proof) = _case(1);
        proof[0] = bytes32(uint256(proof[0]) ^ 1);
        assertFalse(reg.isConflicted(id, voter, proof));
        assertFalse(reg.isConflicted(id, voter, new bytes32[](0)));
    }

    function testFuzz_RandomPairRejected(bytes32 id, address voter) public view {
        (,, bytes32[] memory proof) = _case(2);
        assertFalse(reg.isConflicted(id, voter, proof));
    }

    function test_OnlyOwnerPublishes() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(UmaConflictRegistry.NotOwner.selector);
        reg.publish(bytes32(0), bytes32(0), 0, 0, "");

        reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), 3, 4, "v2");
        assertEq(reg.root(), bytes32(uint256(1)));
        assertEq(reg.version(), 2);
        (bytes32 id, address voter, bytes32[] memory proof) = _case(0);
        assertFalse(reg.isConflicted(id, voter, proof)); // old proofs die with the old root
    }

    function test_Metadata() public view {
        assertEq(reg.leafCount(), fx.readUint(".leafCount"));
        assertEq(reg.datasetHash(), fx.readBytes32(".datasetHash"));
        assertEq(reg.version(), 1);
        assertEq(reg.owner(), address(this));
    }
}
