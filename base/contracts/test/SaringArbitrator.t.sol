// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SaringArbitrator.sol";
import "saring-wormhole/SaringWormholeFixtures.sol";

interface IRealityFull {
    function askQuestion(uint256 template_id, string memory question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce) external payable returns (bytes32);
    function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) external payable;
    function resultFor(bytes32 question_id) external view returns (bytes32);
    function isFinalized(bytes32 question_id) external view returns (bool);
    function claimWinnings(bytes32 question_id, bytes32[] memory history_hashes, address[] memory addrs, uint256[] memory bonds, bytes32[] memory answers) external;
    function balanceOf(address) external view returns (uint256);
}

/// Test-only stand-in recording what the arbitrator sends to Reality.eth.
contract MockReality {
    bytes32 public answer;
    address public payee;
    bool public pending;
    function notifyOfArbitrationRequest(bytes32, address, uint256) external { pending = true; }
    function assignWinnerAndSubmitAnswerByArbitrator(bytes32, bytes32 a, address p, bytes32, bytes32, address) external {
        require(pending, "not pending");
        (answer, payee, pending) = (a, p, false);
    }
}

contract SaringArbitratorTest is Test {
    uint256 constant RELAYER_PK = 0xA11CE;
    bytes32 constant COURT = keccak256("court 24gQ...YGb");
    bytes32 constant Q = keccak256("question");
    bytes32 constant YES = bytes32(uint256(1));

    MockReality mock;
    SaringArbitrator arb;
    address requester = makeAddr("requester");

    function setUp() public {
        mock = new MockReality();
        arb = new SaringArbitrator(IRealityETH(address(mock)), vm.addr(RELAYER_PK), 0.001 ether, IWormhole(address(0)), bytes32(0));
        vm.deal(requester, 1 ether);
    }

    function _v(uint8 yes, uint8 no, bool incomplete) internal pure returns (SaringWormhole.Verdict memory) {
        return SaringWormhole.Verdict(COURT, yes, no, 1, incomplete, 510221975);
    }

    function _sig(SaringArbitrator a, SaringWormhole.Verdict memory v, uint256 pk) internal view returns (uint8, bytes32, bytes32) {
        return vm.sign(pk, a.verdictDigest(v));
    }

    function _requestAndBind() internal {
        vm.prank(requester);
        arb.requestArbitration{value: 0.001 ether}(Q, 0);
        arb.bindCourt(Q, COURT);
    }

    function test_answerMapping() public view {
        assertEq(arb.answerFor(_v(2, 1, false)), YES);
        assertEq(arb.answerFor(_v(0, 1, false)), bytes32(0));
        assertEq(arb.answerFor(_v(1, 1, false)), arb.INVALID());
        assertEq(arb.answerFor(_v(3, 0, true)), arb.INVALID());
    }

    function test_ruleNo() public {
        _requestAndBind();
        (uint8 sv, bytes32 r, bytes32 s) = _sig(arb, _v(0, 1, false), RELAYER_PK);
        arb.rule(Q, _v(0, 1, false), sv, r, s, 0, YES, address(1));
        assertEq(mock.answer(), bytes32(0));
        assertEq(mock.payee(), requester);
        vm.expectRevert(SaringArbitrator.AlreadyRuled.selector);
        arb.rule(Q, _v(0, 1, false), sv, r, s, 0, YES, address(1));
    }

    function test_rejects() public {
        vm.prank(requester);
        vm.expectRevert(SaringArbitrator.FeeTooLow.selector);
        arb.requestArbitration{value: 0.0001 ether}(Q, 0);

        (uint8 sv, bytes32 r, bytes32 s) = _sig(arb, _v(0, 1, false), RELAYER_PK);
        vm.expectRevert(SaringArbitrator.NotRequested.selector);
        arb.rule(Q, _v(0, 1, false), sv, r, s, 0, YES, address(1));

        vm.prank(requester);
        arb.requestArbitration{value: 0.001 ether}(Q, 0);
        vm.expectRevert(SaringArbitrator.AlreadyRequested.selector);
        arb.requestArbitration{value: 0.001 ether}(Q, 0);

        vm.expectRevert(SaringArbitrator.WrongCourt.selector); // not bound yet
        arb.rule(Q, _v(0, 1, false), sv, r, s, 0, YES, address(1));
        arb.bindCourt(Q, COURT);
        vm.expectRevert(SaringArbitrator.AlreadyBound.selector);
        arb.bindCourt(Q, COURT);

        vm.expectRevert(SaringArbitrator.BadSignature.selector); // tampered tally
        arb.rule(Q, _v(5, 1, false), sv, r, s, 0, YES, address(1));

        (uint8 sv2, bytes32 r2, bytes32 s2) = _sig(arb, _v(0, 1, false), 0xB0B);
        vm.expectRevert(SaringArbitrator.BadSignature.selector); // not the relayer
        arb.rule(Q, _v(0, 1, false), sv2, r2, s2, 0, YES, address(1));

        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(SaringArbitrator.BadSignature.selector);
        arb.rule(Q, _v(0, 1, false), sv == 27 ? 28 : 27, r, highS, 0, YES, address(1));

        vm.prank(requester);
        vm.expectRevert(SaringArbitrator.OnlyOwner.selector);
        arb.bindCourt(keccak256("q2"), COURT);
    }

    function test_withdrawFees() public {
        _requestAndBind();
        uint256 before = address(this).balance;
        arb.withdraw();
        assertEq(address(this).balance - before, 0.001 ether);
    }

    receive() external payable {}

    /// Full flow against the real Reality.eth v3 deployment on a Base Sepolia fork.
    function test_fork_realRealityETH() public {
        vm.createSelectFork("https://sepolia.base.org");
        IRealityFull reality = IRealityFull(0x86b653Dc9aa6d7311109276925927087573f91CB);
        SaringArbitrator a = new SaringArbitrator(IRealityETH(address(reality)), vm.addr(RELAYER_PK), 0.001 ether, IWormhole(address(0)), bytes32(0));
        address answerer = makeAddr("answerer");
        vm.deal(answerer, 1 ether);
        vm.deal(requester, 1 ether);

        bytes32 q = reality.askQuestion(0, unicode"Saring fork test?␟other␟en", address(a), 3600, 0, 0);
        uint256 bond = 0.01 ether;
        vm.prank(answerer);
        reality.submitAnswer{value: bond}(q, YES, 0);
        bytes32 h1 = keccak256(abi.encodePacked(bytes32(0), YES, bond, answerer, false));

        vm.prank(requester);
        a.requestArbitration{value: 0.001 ether}(q, bond);
        assertFalse(reality.isFinalized(q));
        a.bindCourt(q, COURT);

        (uint8 sv, bytes32 r, bytes32 s) = _sig(a, _v(0, 1, false), RELAYER_PK);
        a.rule(q, _v(0, 1, false), sv, r, s, bytes32(0), YES, answerer);
        assertTrue(reality.isFinalized(q));
        assertEq(reality.resultFor(q), bytes32(0));

        // Reality.eth credits the wrong answerer's bond to the arbitration requester.
        bytes32[] memory hh = new bytes32[](2);
        (hh[0], hh[1]) = (h1, bytes32(0));
        address[] memory addrs = new address[](2);
        (addrs[0], addrs[1]) = (requester, answerer);
        uint256[] memory bonds = new uint256[](2);
        (bonds[0], bonds[1]) = (0, bond);
        bytes32[] memory answers = new bytes32[](2);
        (answers[0], answers[1]) = (bytes32(0), YES);
        reality.claimWinnings(q, hh, addrs, bonds, answers);
        assertEq(reality.balanceOf(requester), bond);
    }

    // ---------------- Wormhole path: real recorded VAA, real core bridge (Base Sepolia fork) ----------------

    function _forkArb(bytes32 emitter) internal returns (SaringArbitrator a) {
        vm.createSelectFork("https://sepolia.base.org");
        mock = new MockReality();
        a = new SaringArbitrator(IRealityETH(address(mock)), address(0), 0.001 ether, IWormhole(SaringWormholeFixtures.CORE_BASE_SEPOLIA), emitter);
        vm.deal(requester, 1 ether);
        vm.prank(requester);
        a.requestArbitration{value: 0.001 ether}(Q, 0);
    }

    /// Full Reality.eth flow ruled by the guardian-signed VAA alone (relayer = address(0): no Saring key at all).
    function test_fork_vaa_realRealityETH() public {
        vm.createSelectFork("https://sepolia.base.org");
        IRealityFull reality = IRealityFull(0x86b653Dc9aa6d7311109276925927087573f91CB);
        SaringArbitrator a = new SaringArbitrator(IRealityETH(address(reality)), address(0), 0.001 ether, IWormhole(SaringWormholeFixtures.CORE_BASE_SEPOLIA), SaringWormholeFixtures.EMITTER);
        address answerer = makeAddr("answerer");
        vm.deal(answerer, 1 ether);
        vm.deal(requester, 1 ether);
        bytes32 q = reality.askQuestion(0, unicode"Saring VAA fork test?␟other␟en", address(a), 3600, 0, 0);
        vm.prank(answerer);
        reality.submitAnswer{value: 0.01 ether}(q, YES, 0);
        vm.prank(requester);
        a.requestArbitration{value: 0.001 ether}(q, 0.01 ether);
        a.bindCourt(q, SaringWormholeFixtures.COURT);

        vm.prank(makeAddr("anyone"));
        a.ruleWithVaa(q, SaringWormholeFixtures.VAA, bytes32(0), YES, answerer);
        assertTrue(reality.isFinalized(q));
        assertEq(reality.resultFor(q), bytes32(0)); // court 24gQ...YGb resolved NO
        vm.expectRevert(SaringArbitrator.AlreadyRuled.selector);
        a.ruleWithVaa(q, SaringWormholeFixtures.VAA, bytes32(0), YES, answerer);
    }

    function test_fork_vaa_tamperedPayload() public {
        SaringArbitrator a = _forkArb(SaringWormholeFixtures.EMITTER);
        a.bindCourt(Q, SaringWormholeFixtures.COURT);
        bytes memory bad = SaringWormholeFixtures.tampered();
        vm.expectRevert(abi.encodeWithSelector(SaringWormhole.BadVaa.selector, "VM signature invalid"));
        a.ruleWithVaa(Q, bad, 0, YES, address(1));
    }

    function test_fork_vaa_wrongEmitter() public {
        SaringArbitrator a = _forkArb(SaringWormholeFixtures.EMITTER);
        a.bindCourt(Q, SaringWormholeFixtures.COURT);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector); // genuine VAA, other Solana emitter
        a.ruleWithVaa(Q, SaringWormholeFixtures.FOREIGN_VAA, 0, YES, address(1));
        SaringArbitrator other = _forkArb(keccak256("other emitter"));
        other.bindCourt(Q, SaringWormholeFixtures.COURT);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector); // our VAA, contract expects another emitter
        other.ruleWithVaa(Q, SaringWormholeFixtures.VAA, 0, YES, address(1));
    }

    function test_fork_vaa_wrongCourt() public {
        SaringArbitrator a = _forkArb(SaringWormholeFixtures.EMITTER);
        a.bindCourt(Q, COURT);
        vm.expectRevert(SaringArbitrator.WrongCourt.selector);
        a.ruleWithVaa(Q, SaringWormholeFixtures.VAA, 0, YES, address(1));
    }
}
