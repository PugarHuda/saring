// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SaringMarket, IERC20, IWormhole, SaringWormhole} from "../src/SaringMarket.sol";
import "saring-wormhole/SaringWormholeFixtures.sol";

/// Test-only stand-in for a TIP-20 (6 decimals, ERC-20 surface). On Tempo the market uses the real precompile token.
contract TestUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract SaringMarketTest is Test {
    TestUSD usd;
    SaringMarket mkt;
    uint256 relayerKey = 0xA11CE;
    address alice = address(0xA);
    address bob = address(0xB);
    address carol = address(0xC);
    bytes32 court = bytes32(uint256(0x24));

    function setUp() public {
        usd = new TestUSD();
        mkt = new SaringMarket(IERC20(address(usd)), vm.addr(relayerKey), IWormhole(address(0)), bytes32(0));
        mkt.open(court, uint64(block.timestamp + 1 days));
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            usd.mint(who[i], 100e6);
            vm.prank(who[i]);
            usd.approve(address(mkt), type(uint256).max);
        }
    }

    function _v(uint8 y, uint8 n, bool inc) internal view returns (SaringWormhole.Verdict memory) {
        return SaringWormhole.Verdict(court, y, n, 1, inc, 123);
    }

    function _settle(SaringWormhole.Verdict memory v, uint256 key) internal {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, mkt.verdictDigest(v));
        mkt.settle(v, sv, r, s);
    }

    function _bet(address who, bool yes, uint256 a) internal {
        vm.prank(who);
        mkt.bet(court, yes, a);
    }

    function test_noWins_paysProRata_andClosesBets() public {
        _bet(alice, true, 30e6);
        _bet(bob, false, 10e6);
        _bet(carol, false, 30e6);
        _settle(_v(0, 1, false), relayerKey);
        (,, SaringMarket.Outcome o,) = mkt.markets(court);
        assertEq(uint8(o), uint8(SaringMarket.Outcome.No));

        vm.expectRevert(SaringMarket.MarketClosed.selector);
        _bet(alice, true, 1e6);

        vm.prank(bob); mkt.claim(court);
        vm.prank(carol); mkt.claim(court);
        assertEq(usd.balanceOf(bob), 90e6 + 17_500_000);   // 10/40 of 70
        assertEq(usd.balanceOf(carol), 70e6 + 52_500_000); // 30/40 of 70
        vm.prank(alice);
        vm.expectRevert(SaringMarket.NothingToClaim.selector);
        mkt.claim(court);
        vm.prank(bob);
        vm.expectRevert(SaringMarket.NothingToClaim.selector);
        mkt.claim(court); // no double claim
    }

    function test_badSignature_reverts() public {
        _bet(alice, true, 1e6);
        SaringWormhole.Verdict memory v = _v(2, 1, false);
        vm.expectRevert(SaringMarket.BadSignature.selector);
        this.settleWith(v, 0xB0B); // signed by the wrong key
        // valid signature over a different verdict (tampered tally)
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(relayerKey, mkt.verdictDigest(v));
        v.no = 3;
        vm.expectRevert(SaringMarket.BadSignature.selector);
        mkt.settle(v, sv, r, s);
    }

    function test_highS_rejected() public {
        SaringWormhole.Verdict memory v = _v(2, 1, false);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(relayerKey, mkt.verdictDigest(v));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        vm.expectRevert(SaringMarket.BadSignature.selector);
        mkt.settle(v, sv == 27 ? 28 : 27, r, bytes32(n - uint256(s)));
    }

    function settleWith(SaringWormhole.Verdict memory v, uint256 key) external { _settle(v, key); }

    function test_doubleSettle_reverts() public {
        _bet(alice, true, 1e6);
        _settle(_v(2, 1, false), relayerKey);
        vm.expectRevert(SaringMarket.MarketClosed.selector);
        this.settleWith(_v(0, 3, false), relayerKey);
    }

    function test_tie_refunds() public {
        _bet(alice, true, 5e6);
        _bet(bob, false, 7e6);
        _settle(_v(1, 1, false), relayerKey);
        vm.prank(alice); mkt.claim(court);
        vm.prank(bob); mkt.claim(court);
        assertEq(usd.balanceOf(alice), 100e6);
        assertEq(usd.balanceOf(bob), 100e6);
    }

    function test_incomplete_refunds() public {
        _bet(alice, true, 5e6);
        _bet(bob, false, 7e6);
        _settle(_v(3, 0, true), relayerKey);
        vm.prank(alice); mkt.claim(court);
        assertEq(usd.balanceOf(alice), 100e6);
    }

    function test_emptyWinningSide_refunds() public {
        _bet(alice, true, 5e6);
        _settle(_v(0, 2, false), relayerKey);
        (,, SaringMarket.Outcome o,) = mkt.markets(court);
        assertEq(uint8(o), uint8(SaringMarket.Outcome.Refund));
        vm.prank(alice); mkt.claim(court);
        assertEq(usd.balanceOf(alice), 100e6);
    }

    function test_claimBeforeSettle_reverts() public {
        _bet(alice, true, 5e6);
        vm.prank(alice);
        vm.expectRevert(SaringMarket.NotSettled.selector);
        mkt.claim(court);
    }

    function test_zeroBet_reverts() public {
        vm.prank(alice);
        vm.expectRevert(SaringMarket.ZeroAmount.selector);
        mkt.bet(court, true, 0);
    }

    // ---------------- Security review 2026-10-13 ----------------

    /// Finding 2: no bets once the deadline passed (the verdict may already be public on Solana).
    function test_betAfterDeadline_reverts() public {
        _bet(alice, true, 1e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        vm.expectRevert(SaringMarket.MarketClosed.selector);
        mkt.bet(court, false, 1e6);
    }

    /// Finding 2: a court the owner never opened takes no bets at all.
    function test_betOnUnopenedCourt_reverts() public {
        vm.prank(alice);
        vm.expectRevert(SaringMarket.MarketClosed.selector);
        mkt.bet(bytes32(uint256(0x99)), true, 1e6);
    }

    function test_open_onlyOwner_once_futureDeadline() public {
        bytes32 c2 = bytes32(uint256(0x77));
        vm.prank(alice);
        vm.expectRevert(SaringMarket.OnlyOwner.selector);
        mkt.open(c2, uint64(block.timestamp + 1));
        vm.expectRevert(SaringMarket.BadDeadline.selector);
        mkt.open(c2, uint64(block.timestamp));
        vm.expectRevert(SaringMarket.AlreadyOpen.selector);
        mkt.open(court, uint64(block.timestamp + 2 days)); // can't extend a running market
    }

    /// Finding 1: a deployment wired to a Wormhole core can't be built with a relayer key ...
    function test_relayerWithWormhole_cannotDeploy() public {
        vm.expectRevert(SaringWormhole.RelayerWithVaa.selector);
        new SaringMarket(IERC20(address(usd)), vm.addr(relayerKey), IWormhole(address(0xC0DE)), bytes32(0));
    }

    /// ... and on a VAA-only deployment a relayer-signed verdict is rejected, even one signed by the old relayer key.
    function test_vaaOnly_rejectsRelayerSignedVerdict() public {
        SaringMarket m = new SaringMarket(IERC20(address(usd)), address(0), IWormhole(address(0xC0DE)), bytes32(0));
        m.open(court, uint64(block.timestamp + 1 days));
        SaringWormhole.Verdict memory v = _v(9, 0, false);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(relayerKey, m.verdictDigest(v));
        vm.expectRevert(SaringMarket.BadSignature.selector);
        m.settle(v, sv, r, s);
        (,, SaringMarket.Outcome o,) = m.markets(court);
        assertEq(uint8(o), uint8(SaringMarket.Outcome.Open));
    }

    // ---------------- Wormhole path: real recorded VAA, real core bridge (Tempo Moderato fork) ----------------

    function _forkMarket(bytes32 emitter) internal returns (SaringMarket m) {
        vm.createSelectFork("https://rpc.moderato.tempo.xyz");
        usd = new TestUSD();
        m = new SaringMarket(IERC20(address(usd)), address(0), IWormhole(SaringWormholeFixtures.CORE_TEMPO_MODERATO), emitter);
        bytes32 c = SaringWormholeFixtures.COURT;
        m.open(c, uint64(block.timestamp + 1 hours));
        usd.mint(alice, 3e6);
        usd.mint(bob, 2e6);
        vm.startPrank(alice);
        usd.approve(address(m), 3e6);
        m.bet(c, true, 3e6);
        vm.stopPrank();
        vm.startPrank(bob);
        usd.approve(address(m), 2e6);
        m.bet(c, false, 2e6);
        vm.stopPrank();
    }

    /// Settled by the guardian-signed VAA alone (relayer = address(0): no Saring key at all).
    function test_fork_vaa_settlesNo() public {
        SaringMarket m = _forkMarket(SaringWormholeFixtures.EMITTER);
        vm.prank(carol);
        m.settleWithVaa(SaringWormholeFixtures.VAA);
        assertEq(m.claimable(SaringWormholeFixtures.COURT, bob), 5e6);
        assertEq(m.claimable(SaringWormholeFixtures.COURT, alice), 0);
        vm.expectRevert(SaringMarket.MarketClosed.selector);
        m.settleWithVaa(SaringWormholeFixtures.VAA);
    }

    function test_fork_vaa_tamperedPayload() public {
        SaringMarket m = _forkMarket(SaringWormholeFixtures.EMITTER);
        bytes memory bad = SaringWormholeFixtures.tampered();
        vm.expectRevert(abi.encodeWithSelector(SaringWormhole.BadVaa.selector, "VM signature invalid"));
        m.settleWithVaa(bad);
    }

    function test_fork_vaa_wrongEmitter() public {
        SaringMarket m = _forkMarket(SaringWormholeFixtures.EMITTER);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector);
        m.settleWithVaa(SaringWormholeFixtures.FOREIGN_VAA);
        SaringMarket other = _forkMarket(keccak256("other emitter"));
        vm.expectRevert(SaringWormhole.WrongEmitter.selector);
        other.settleWithVaa(SaringWormholeFixtures.VAA);
    }
}
