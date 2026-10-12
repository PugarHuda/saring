// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SaringMarket, IERC20} from "../src/SaringMarket.sol";

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
        mkt = new SaringMarket(IERC20(address(usd)), vm.addr(relayerKey));
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            usd.mint(who[i], 100e6);
            vm.prank(who[i]);
            usd.approve(address(mkt), type(uint256).max);
        }
    }

    function _v(uint8 y, uint8 n, bool inc) internal view returns (SaringMarket.Verdict memory) {
        return SaringMarket.Verdict(court, y, n, 1, inc, 123);
    }

    function _settle(SaringMarket.Verdict memory v, uint256 key) internal {
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
        (,, SaringMarket.Outcome o) = mkt.markets(court);
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
        SaringMarket.Verdict memory v = _v(2, 1, false);
        vm.expectRevert(SaringMarket.BadSignature.selector);
        this.settleWith(v, 0xB0B); // signed by the wrong key
        // valid signature over a different verdict (tampered tally)
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(relayerKey, mkt.verdictDigest(v));
        v.no = 3;
        vm.expectRevert(SaringMarket.BadSignature.selector);
        mkt.settle(v, sv, r, s);
    }

    function test_highS_rejected() public {
        SaringMarket.Verdict memory v = _v(2, 1, false);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(relayerKey, mkt.verdictDigest(v));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        vm.expectRevert(SaringMarket.BadSignature.selector);
        mkt.settle(v, sv == 27 ? 28 : 27, r, bytes32(n - uint256(s)));
    }

    function settleWith(SaringMarket.Verdict memory v, uint256 key) external { _settle(v, key); }

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
        (,, SaringMarket.Outcome o) = mkt.markets(court);
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
}
