// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SaringHyperCourt, IWormhole, SaringWormhole} from "../src/SaringHyperCourt.sol";
import "saring-wormhole/SaringWormholeFixtures.sol";

/// Stands in for a HyperCore read precompile (anvil has none): returns whatever was set for the exact input.
contract PrecompileMock {
    mapping(bytes32 => bytes) internal ret;
    function set(bytes calldata input, bytes calldata output) external { ret[keccak256(input)] = output; }
    fallback(bytes calldata input) external returns (bytes memory) {
        bytes memory o = ret[keccak256(input)];
        require(o.length > 0, "precompile: bad input");
        return o;
    }
}

contract CoreWriterMock {
    bytes public last;
    address public sender;
    function sendRawAction(bytes calldata data) external { last = data; sender = msg.sender; }
}

contract SaringHyperCourtTest is Test {
    address constant HYPEEVM_WORMHOLE = 0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd; // HyperEVM testnet core bridge
    uint64 constant HYPE = 1105;
    uint32 constant HYPE_PERP = 135;
    uint32 constant OUTCOME = 8659;
    bytes32 constant COURT = keccak256("FoRH court");

    uint256 relayerKey = 0xA11CE;
    address disputer = makeAddr("disputer");
    SaringHyperCourt c;

    function setUp() public {
        _mockCore();
        c = new SaringHyperCourt(vm.addr(relayerKey), IWormhole(address(0)), bytes32(0), HYPE, HYPE_PERP);
        c.open(OUTCOME, COURT, false);
        _set(c.CORE_USER_EXISTS(), abi.encode(disputer), abi.encode(true));
        vm.deal(disputer, 1 ether);
    }

    function _mockCore() internal {
        vm.etch(0x3333333333333333333333333333333333333333, address(new CoreWriterMock()).code);
        address[4] memory pre = [address(0x801), address(0x807), address(0x809), address(0x810)];
        for (uint256 i; i < 4; i++) vm.etch(pre[i], address(new PrecompileMock()).code);
        _set(address(0x809), "", abi.encode(uint64(730_000_000)));
        _set(address(0x807), abi.encode(HYPE_PERP), abi.encode(uint64(41_250)));
    }

    function _set(address p, bytes memory i, bytes memory o) internal { PrecompileMock(payable(p)).set(i, o); }

    function _coreBal(address who, uint64 total) internal {
        _set(address(0x801), abi.encode(who, HYPE), abi.encode(total, uint64(0), uint64(0)));
    }

    function _v(uint8 y, uint8 n, bool inc) internal pure returns (SaringWormhole.Verdict memory) {
        return SaringWormhole.Verdict(COURT, y, n, 1, inc, 123);
    }

    function _sign(SaringWormhole.Verdict memory v, uint256 key) internal view returns (uint8, bytes32, bytes32) {
        return vm.sign(key, c.verdictDigest(v));
    }

    function _settle(uint32 outcome, SaringWormhole.Verdict memory v) internal {
        (uint8 sv, bytes32 r, bytes32 s) = _sign(v, relayerKey);
        c.settle(outcome, v, sv, r, s);
    }

    function _result(uint32 o) internal view returns (SaringHyperCourt.Result r) {
        (,, r,,,,,) = c.markets(o);
    }

    function test_disputeBridgesBondToCore() public {
        vm.prank(disputer);
        c.dispute{value: 0.01 ether}(OUTCOME, false);
        assertEq(c.HYPE_SYSTEM().balance, 0.01 ether); // native HYPE -> 0x2222..2222 = credit on HyperCore
        (,,, address d, bool yes, uint64 bond,,) = c.markets(OUTCOME);
        assertEq(d, disputer);
        assertFalse(yes);
        assertEq(bond, 1e6); // 0.01 HYPE in Core wei (8 decimals)
    }

    function test_disputeRejectsDustAndUnknownCoreUser() public {
        vm.prank(disputer);
        vm.expectRevert(SaringHyperCourt.BadBond.selector);
        c.dispute{value: 0.01 ether + 1}(OUTCOME, false); // not representable in Core wei
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        _set(c.CORE_USER_EXISTS(), abi.encode(stranger), abi.encode(false));
        vm.prank(stranger);
        vm.expectRevert(SaringHyperCourt.NoCoreAccount.selector);
        c.dispute{value: 0.01 ether}(OUTCOME, false);
    }

    function test_rightDisputerGetsBondViaCoreWriterSpotSend() public {
        vm.prank(disputer);
        c.dispute{value: 0.01 ether}(OUTCOME, false);
        _coreBal(address(c), 1e6);
        _settle(OUTCOME, _v(0, 2, false)); // NO, as the disputer claimed

        bytes memory expected = abi.encodePacked(uint8(1), uint24(6), abi.encode(disputer, HYPE, uint64(1e6)));
        CoreWriterMock cw = CoreWriterMock(c.CORE_WRITER());
        assertEq(cw.last(), expected);
        assertEq(cw.sender(), address(c));
        assertEq(uint8(_result(OUTCOME)), uint8(SaringHyperCourt.Result.No));
        (,,,,,, uint64 l1, uint64 px) = c.markets(OUTCOME);
        assertEq(l1, 730_000_000);
        assertEq(px, 41_250);
        assertEq(c.settleFraction(OUTCOME), 0);
    }

    function test_wrongDisputerForfeits() public {
        vm.prank(disputer);
        c.dispute{value: 0.01 ether}(OUTCOME, true);
        _settle(OUTCOME, _v(0, 2, false));
        assertEq(CoreWriterMock(c.CORE_WRITER()).last().length, 0);
        assertEq(c.settleFraction(OUTCOME), 0);
    }

    function test_refundNeedsCoreBalance() public {
        vm.prank(disputer);
        c.dispute{value: 0.01 ether}(OUTCOME, false);
        _coreBal(address(c), 5e5);
        SaringWormhole.Verdict memory v = _v(0, 2, false);
        (uint8 sv, bytes32 r, bytes32 s) = _sign(v, relayerKey);
        vm.expectRevert(abi.encodeWithSelector(SaringHyperCourt.InsufficientCoreBalance.selector, uint64(5e5), uint64(1e6)));
        c.settle(OUTCOME, v, sv, r, s);
    }

    function test_settleFractionRules() public {
        _settle(OUTCOME, _v(2, 1, false));
        assertEq(c.settleFraction(OUTCOME), 1e18);

        c.open(1, COURT, false);
        _settle(1, _v(1, 1, false)); // tie, standalone
        assertEq(c.settleFraction(1), 5e17);

        c.open(2, COURT, true);
        _settle(2, _v(2, 0, true)); // incomplete, question outcome: 0/1 only
        vm.expectRevert(SaringHyperCourt.NoFraction.selector);
        c.settleFraction(2);

        c.open(3, COURT, true);
        vm.expectRevert(SaringHyperCourt.NotSettled.selector);
        c.settleFraction(3);
    }

    function test_rejectsBadSignatureWrongCourtAndReplay() public {
        SaringWormhole.Verdict memory v = _v(0, 2, false);
        (uint8 sv, bytes32 r, bytes32 s) = _sign(v, 0xBAD);
        vm.expectRevert(SaringHyperCourt.BadSignature.selector);
        c.settle(OUTCOME, v, sv, r, s);

        SaringWormhole.Verdict memory other = SaringWormhole.Verdict(keccak256("other"), 0, 2, 0, false, 1);
        (sv, r, s) = _sign(other, relayerKey);
        vm.expectRevert(SaringHyperCourt.WrongCourt.selector);
        c.settle(OUTCOME, other, sv, r, s);

        _settle(OUTCOME, v);
        (sv, r, s) = _sign(v, relayerKey);
        vm.expectRevert(SaringHyperCourt.NotOpen.selector);
        c.settle(OUTCOME, v, sv, r, s);
    }

    /// Security review finding 1: a court wired to a Wormhole core can't also trust a relayer key.
    function test_relayerWithWormhole_cannotDeploy() public {
        vm.expectRevert(SaringWormhole.RelayerWithVaa.selector);
        new SaringHyperCourt(vm.addr(relayerKey), IWormhole(address(0xC0DE)), bytes32(0), HYPE, HYPE_PERP);
    }

    function test_onlyOwnerOpens() public {
        vm.prank(disputer);
        vm.expectRevert(SaringHyperCourt.NotOwner.selector);
        c.open(9, COURT, false);
    }

    // ---- Wormhole path: real recorded VAA against the real core bridge on a HyperEVM testnet fork ----

    function _forkCourt(bytes32 emitter) internal returns (SaringHyperCourt f) {
        vm.createSelectFork("hyperevm_testnet");
        _mockCore(); // anvil forks do not run HyperCore precompiles
        f = new SaringHyperCourt(address(0), IWormhole(HYPEEVM_WORMHOLE), emitter, HYPE, HYPE_PERP);
        f.open(OUTCOME, SaringWormholeFixtures.COURT, false);
    }

    function test_fork_vaaSettlesNoWithoutAnyKey() public {
        SaringHyperCourt f = _forkCourt(SaringWormholeFixtures.EMITTER);
        f.settleWithVaa(OUTCOME, SaringWormholeFixtures.VAA);
        (,, SaringHyperCourt.Result r,,,,,) = f.markets(OUTCOME);
        assertEq(uint8(r), uint8(SaringHyperCourt.Result.No));
        assertEq(f.settleFraction(OUTCOME), 0);
    }

    function test_fork_vaaRejectsForeignEmitterAndTamper() public {
        SaringHyperCourt f = _forkCourt(SaringWormholeFixtures.EMITTER);
        vm.expectRevert(SaringWormhole.WrongEmitter.selector);
        f.settleWithVaa(OUTCOME, SaringWormholeFixtures.FOREIGN_VAA);
        vm.expectRevert();
        f.settleWithVaa(OUTCOME, SaringWormholeFixtures.tampered());
    }
}
