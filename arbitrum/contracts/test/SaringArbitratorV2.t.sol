// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SaringArbitratorV2.sol";
import "../src/SaringEscrow.sol";
import "saring-wormhole/SaringWormholeFixtures.sol";

/// Test-only core bridge: treats the "VAA" bytes as the raw 45-byte payload, always valid, Saring emitter.
contract MockWormhole {
    function parseAndVerifyVM(bytes calldata p) external pure returns (IWormhole.VM memory m, bool, string memory) {
        m.emitterChainId = 1;
        m.emitterAddress = SaringWormholeFixtures.EMITTER;
        m.payload = p;
        return (m, true, "");
    }
}

contract SaringArbitratorV2Test is Test {
    uint256 constant FEE = 0.0001 ether;
    bytes32 constant COURT = SaringWormholeFixtures.COURT;
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address operator = makeAddr("operator");

    SaringArbitratorV2 arb;
    SaringEscrow esc;

    function _deploy(IWormhole w, bytes32 emitter) internal {
        vm.prank(operator);
        arb = new SaringArbitratorV2(w, emitter, FEE);
        esc = new SaringEscrow(arb);
        vm.deal(payer, 10 ether);
        vm.deal(payee, 1 ether);
    }

    /// open a 1 ETH deal, payee disputes, operator binds `court`; returns the disputeID
    function _disputed(bytes32 court) internal returns (uint256 d) {
        vm.prank(payer);
        uint256 id = esc.open{value: 1 ether}(payee);
        vm.prank(payee);
        d = esc.dispute{value: FEE}(id);
        vm.prank(operator);
        arb.bindCourt(d, court);
    }

    function _payload(uint8 yes, uint8 no, bool incomplete) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), COURT, yes, no, uint8(0), incomplete ? uint8(1) : uint8(0), uint64(42));
    }

    function test_rulingMapping() public {
        _deploy(IWormhole(address(new MockWormhole())), SaringWormholeFixtures.EMITTER);
        assertEq(arb.arbitrationCost(""), FEE);

        uint256 d = _disputed(COURT);
        assertEq(operator.balance, FEE); // fee forwarded to the operator
        arb.ruleWithVaa(d, _payload(2, 1, false)); // YES -> payee
        (uint256 r, bool tied, bool over) = arb.currentRuling(d);
        assertEq(abi.encode(r, tied, over), abi.encode(uint256(1), false, false));
        assertEq(payee.balance, 1 ether - FEE + 1 ether);

        d = _disputed(COURT);
        uint256 before = payer.balance;
        arb.ruleWithVaa(d, _payload(1, 1, false)); // tie -> refused (0), split
        (r, tied,) = arb.currentRuling(d);
        assertEq(abi.encode(r, tied), abi.encode(uint256(0), true));
        assertEq(payer.balance - before, 0.5 ether);

        d = _disputed(COURT);
        arb.ruleWithVaa(d, _payload(3, 0, true)); // incomplete -> refused, not tied
        (r, tied,) = arb.currentRuling(d);
        assertEq(abi.encode(r, tied), abi.encode(uint256(0), false));
    }

    function test_rejects() public {
        _deploy(IWormhole(address(new MockWormhole())), SaringWormholeFixtures.EMITTER);
        vm.expectRevert(SaringArbitratorV2.OnlyBinary.selector);
        arb.createDispute{value: FEE}(3, "");
        vm.expectRevert(SaringArbitratorV2.InsufficientFee.selector);
        arb.createDispute{value: FEE - 1}(2, "");
        vm.expectRevert(SaringArbitratorV2.TokenNotAccepted.selector);
        arb.createDispute(2, "", IERC20(address(1)), 1);
        vm.expectRevert(SaringArbitratorV2.UnknownDispute.selector);
        arb.currentRuling(0);

        vm.prank(payer);
        uint256 id = esc.open{value: 1 ether}(payee);
        vm.expectRevert(SaringEscrow.NotParty.selector);
        esc.dispute{value: FEE}(id);
        vm.prank(payer);
        uint256 d = esc.dispute{value: FEE}(id);
        vm.expectRevert(SaringArbitratorV2.WrongCourt.selector); // unbound
        arb.ruleWithVaa(d, _payload(0, 1, false));
        vm.expectRevert(SaringArbitratorV2.OnlyOwner.selector);
        arb.bindCourt(d, COURT);
        vm.prank(operator);
        arb.bindCourt(d, COURT);
        vm.prank(operator);
        vm.expectRevert(SaringArbitratorV2.AlreadyBound.selector);
        arb.bindCourt(d, COURT);
        vm.expectRevert(SaringEscrow.OnlyArbitrator.selector);
        esc.rule(d, 1);
        vm.expectRevert(SaringWormhole.BadPayload.selector);
        arb.ruleWithVaa(d, abi.encodePacked(uint8(2), COURT, uint96(0)));
        arb.ruleWithVaa(d, _payload(0, 1, false));
        vm.expectRevert(SaringArbitratorV2.AlreadyRuled.selector);
        arb.ruleWithVaa(d, _payload(0, 1, false));
        vm.prank(payer);
        vm.expectRevert(SaringEscrow.Closed.selector);
        esc.release(id);
    }

    function test_releaseWithoutDispute() public {
        _deploy(IWormhole(address(new MockWormhole())), SaringWormholeFixtures.EMITTER);
        vm.prank(payer);
        uint256 id = esc.open{value: 1 ether}(payee);
        vm.prank(payer);
        esc.release(id);
        assertEq(payee.balance, 2 ether);
    }

    // ---------------- real recorded VAA, real Wormhole core bridge (Arbitrum Sepolia fork) ----------------

    function _fork(bytes32 emitter) internal {
        vm.createSelectFork("https://sepolia-rollup.arbitrum.io/rpc");
        _deploy(IWormhole(SaringWormholeFixtures.CORE_ARBITRUM_SEPOLIA), emitter);
    }

    /// Court 24gQ...YGb resolved NO (yes 0, no 1): ruling 2, the escrow refunds the payer.
    function test_fork_vaa_fullFlow() public {
        _fork(SaringWormholeFixtures.EMITTER);
        uint256 d = _disputed(COURT);
        vm.expectEmit(true, true, false, true, address(arb));
        emit IArbitratorV2.Ruling(esc, d, 2);
        vm.prank(makeAddr("anyone"));
        arb.ruleWithVaa(d, SaringWormholeFixtures.VAA);
        (uint256 r, bool tied,) = arb.currentRuling(d);
        assertEq(abi.encode(r, tied), abi.encode(uint256(2), false));
        assertEq(payer.balance, 10 ether); // 1 ETH deposit refunded
        assertEq(payee.balance, 1 ether - FEE);
        assertEq(address(esc).balance, 0);
        vm.expectRevert(SaringArbitratorV2.AlreadyRuled.selector);
        arb.ruleWithVaa(d, SaringWormholeFixtures.VAA);
    }

    function test_fork_vaa_tampered() public {
        _fork(SaringWormholeFixtures.EMITTER);
        uint256 d = _disputed(COURT);
        bytes memory bad = SaringWormholeFixtures.tampered();
        vm.expectRevert(abi.encodeWithSelector(SaringWormhole.BadVaa.selector, "VM signature invalid"));
        arb.ruleWithVaa(d, bad);
    }

    function test_fork_vaa_wrongEmitter() public {
        _fork(SaringWormholeFixtures.EMITTER);
        uint256 d = _disputed(COURT);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector); // genuine guardian sigs, another Solana program
        arb.ruleWithVaa(d, SaringWormholeFixtures.FOREIGN_VAA);

        _deploy(IWormhole(SaringWormholeFixtures.CORE_ARBITRUM_SEPOLIA), keccak256("other emitter"));
        d = _disputed(COURT);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector); // our VAA, arbitrator expecting someone else
        arb.ruleWithVaa(d, SaringWormholeFixtures.VAA);
    }

    function test_fork_vaa_wrongCourt() public {
        _fork(SaringWormholeFixtures.EMITTER);
        uint256 d = _disputed(keccak256("another court"));
        vm.expectRevert(SaringArbitratorV2.WrongCourt.selector);
        arb.ruleWithVaa(d, SaringWormholeFixtures.VAA);
    }
}
