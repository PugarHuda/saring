// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SaringEscalationManager.sol";

interface IERC20T {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allocateTo(address, uint256) external;
}

interface IOOv3 {
    function assertTruth(bytes memory claim, address asserter, address callbackRecipient, address escalationManager, uint64 liveness, address currency, uint256 bond, bytes32 identifier, bytes32 domainId) external returns (bytes32);
    function disputeAssertion(bytes32 assertionId, address disputer) external;
    function settleAssertion(bytes32 assertionId) external;
    function getAssertionResult(bytes32 assertionId) external view returns (bool);
}

/// Test-only stand-in for OOv3: same stamp format, same requestPrice / staticcall getPrice sequence.
contract MockOO {
    mapping(bytes32 => address) public asserter;
    function stampAssertion(bytes32 id) public view returns (bytes memory) {
        return abi.encodePacked("assertionId:", _hex(id), ",ooAsserter:", _hex(bytes32(uint256(uint160(asserter[id])))));
    }
    function dispute(SaringEscalationManager em, bytes32 id) external {
        asserter[id] = msg.sender;
        em.requestPrice("ASSERT_TRUTH", 1, stampAssertion(id));
    }
    function price(SaringEscalationManager em, bytes32 id) external view returns (int256) {
        return em.getPrice("ASSERT_TRUTH", 1, stampAssertion(id));
    }
    function _hex(bytes32 b) internal pure returns (bytes memory s) {
        s = new bytes(64);
        bytes16 h = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            s[2 * i] = h[uint8(b[i]) >> 4];
            s[2 * i + 1] = h[uint8(b[i]) & 15];
        }
    }
}

contract SaringEscalationManagerTest is Test {
    uint256 constant RELAYER_PK = 0xA11CE;
    bytes32 constant COURT = keccak256("court 24gQ...YGb");
    bytes32 constant ID = keccak256("assertion");

    MockOO mock;
    SaringEscalationManager em;

    function setUp() public {
        mock = new MockOO();
        em = new SaringEscalationManager(address(mock), vm.addr(RELAYER_PK));
    }

    function _v(uint8 yes, uint8 no, bool incomplete) internal pure returns (SaringEscalationManager.Verdict memory) {
        return SaringEscalationManager.Verdict(COURT, yes, no, 1, incomplete, 510221975);
    }

    function _resolve(SaringEscalationManager m, bytes32 id, SaringEscalationManager.Verdict memory v, uint256 pk) internal {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, m.verdictDigest(v));
        m.resolve(id, v, sv, r, s);
    }

    /// expectRevert applies to the next call, so sign first, then expect, then resolve.
    function _expectResolveRevert(bytes4 err, bytes32 id, SaringEscalationManager.Verdict memory v, uint256 pk) internal {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, em.verdictDigest(v));
        vm.expectRevert(err);
        em.resolve(id, v, sv, r, s);
    }

    function test_policyUnplugsDvm() public view {
        EscalationManagerInterface.AssertionPolicy memory p = em.getAssertionPolicy(ID);
        assertTrue(p.arbitrateViaEscalationManager);
        assertFalse(p.blockAssertion || p.discardOracle || p.validateDisputers);
    }

    function test_noVerdictPricesFalse_yesVerdictPricesTrue() public {
        mock.dispute(em, ID);
        (, , bytes32 parsed, , ) = em.requests(keccak256(mock.stampAssertion(ID)));
        assertEq(parsed, ID);
        vm.expectRevert(SaringEscalationManager.NotResolved.selector);
        mock.price(em, ID);
        em.bindCourt(ID, COURT);
        _resolve(em, ID, _v(0, 1, false), RELAYER_PK);
        assertEq(mock.price(em, ID), 0);

        bytes32 id2 = keccak256("assertion 2");
        mock.dispute(em, id2);
        em.bindCourt(id2, COURT);
        _resolve(em, id2, _v(2, 1, false), RELAYER_PK);
        assertEq(mock.price(em, id2), 1e18);
    }

    function test_tieAndIncompleteAreFalse() public {
        mock.dispute(em, ID);
        em.bindCourt(ID, COURT);
        _resolve(em, ID, _v(1, 1, false), RELAYER_PK);
        assertEq(mock.price(em, ID), 0);
        bytes32 id2 = keccak256("x");
        mock.dispute(em, id2);
        em.bindCourt(id2, COURT);
        _resolve(em, id2, _v(3, 0, true), RELAYER_PK);
        assertEq(mock.price(em, id2), 0);
    }

    function test_rejects() public {
        mock.dispute(em, ID);
        _expectResolveRevert(SaringEscalationManager.WrongCourt.selector, ID, _v(0, 1, false), RELAYER_PK); // unbound
        em.bindCourt(ID, COURT);
        vm.expectRevert(SaringEscalationManager.AlreadyBound.selector);
        em.bindCourt(ID, COURT);

        SaringEscalationManager.Verdict memory other = _v(0, 1, false);
        other.court = keccak256("other");
        _expectResolveRevert(SaringEscalationManager.WrongCourt.selector, ID, other, RELAYER_PK);

        _expectResolveRevert(SaringEscalationManager.BadSignature.selector, ID, _v(0, 1, false), 0xB0B); // not the relayer

        SaringEscalationManager.Verdict memory v = _v(0, 1, false);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(RELAYER_PK, em.verdictDigest(v));
        v.yes = 5; // tampered after signing
        vm.expectRevert(SaringEscalationManager.BadSignature.selector);
        em.resolve(ID, v, sv, r, s);

        v.yes = 0; // high-s twin of a valid signature
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(SaringEscalationManager.BadSignature.selector);
        em.resolve(ID, v, sv == 27 ? 28 : 27, r, highS);

        em.resolve(ID, v, sv, r, s);
        vm.expectRevert(SaringEscalationManager.AlreadyResolved.selector);
        em.resolve(ID, v, sv, r, s);
    }

    function test_accessControl() public {
        bytes memory stamp = mock.stampAssertion(ID);
        vm.expectRevert(SaringEscalationManager.OnlyOracle.selector);
        em.requestPrice("ASSERT_TRUTH", 1, stamp);
        vm.prank(address(0xBEEF));
        vm.expectRevert(SaringEscalationManager.OnlyOwner.selector);
        em.bindCourt(ID, COURT);
        bytes32 notRequested = keccak256("never disputed");
        em.bindCourt(notRequested, COURT);
        _expectResolveRevert(SaringEscalationManager.NotRequested.selector, notRequested, _v(0, 1, false), RELAYER_PK);
    }

    /// Full flow against the real UMA OOv3 deployment on an Arbitrum Sepolia fork.
    function test_fork_realOOv3() public {
        vm.createSelectFork("https://sepolia-rollup.arbitrum.io/rpc");
        IOOv3 oo = IOOv3(0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8);
        IERC20T dbt = IERC20T(0x689FF0D2c17ECbB01477420aB18482A8DAd45186);
        SaringEscalationManager m = new SaringEscalationManager(address(oo), vm.addr(RELAYER_PK));
        address asserter = makeAddr("asserter");
        address disputer = makeAddr("disputer");
        uint256 bond = 100e18;
        dbt.allocateTo(asserter, bond);
        dbt.allocateTo(disputer, bond);

        vm.startPrank(asserter);
        dbt.approve(address(oo), bond);
        bytes32 id = oo.assertTruth("claim", asserter, address(0), address(m), 7200, address(dbt), bond, "ASSERT_TRUTH", 0);
        vm.stopPrank();
        m.bindCourt(id, COURT);

        vm.startPrank(disputer);
        dbt.approve(address(oo), bond);
        oo.disputeAssertion(id, disputer);
        vm.stopPrank();

        vm.expectRevert(); // getPrice reverts until Saring rules
        oo.settleAssertion(id);

        _resolve(m, id, _v(0, 1, false), RELAYER_PK);
        oo.settleAssertion(id);
        assertFalse(oo.getAssertionResult(id));
        assertEq(dbt.balanceOf(disputer), 150e18); // 2x bond minus 50% burned to UMA Store
        assertEq(dbt.balanceOf(asserter), 0);
    }
}
