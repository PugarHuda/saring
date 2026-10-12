// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "saring-wormhole/SaringWormhole.sol";

/// Minimal ERC-20 surface. TIP-20 tokens on Tempo (pathUSD, AlphaUSD, ...) implement it.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SaringMarket
/// @notice YES/NO pari-mutuel markets in a TIP-20 stablecoin, one per Saring court.
///         A market settles ONLY on a Saring verdict of the court's on-chain tally (Solana devnet):
///         either a Wormhole VAA (settleWithVaa: guardian-attested, no Saring key) or the legacy
///         EIP-712 attestation signed by the Saring relayer key (settle).
///         Tie, incomplete conflict check, or an empty winning side => full refund.
contract SaringMarket is SaringWormhole {
    enum Outcome { Open, Yes, No, Refund }

    struct Market {
        uint256 yesPool;
        uint256 noPool;
        Outcome outcome;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 court,uint8 yes,uint8 no,uint8 excluded,bool incomplete,uint64 resolvedSlot)"
    );
    // secp256k1n / 2: reject malleable (high-s) signatures.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IERC20 public immutable token;
    address public immutable relayer;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => uint256)) public yesStake;
    mapping(bytes32 => mapping(address => uint256)) public noStake;

    event Bet(bytes32 indexed court, address indexed bettor, bool yes, uint256 amount);
    event Settled(bytes32 indexed court, Outcome outcome, uint8 yes, uint8 no, uint8 excluded, bool incomplete, uint64 resolvedSlot);
    event Claimed(bytes32 indexed court, address indexed bettor, uint256 amount);

    error MarketClosed();
    error NotSettled();
    error BadSignature();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    constructor(IERC20 token_, address relayer_, IWormhole wormhole_, bytes32 emitter_) SaringWormhole(wormhole_, emitter_) {
        token = token_;
        relayer = relayer_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SaringMarket"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function bet(bytes32 court, bool yes, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Market storage m = markets[court];
        if (m.outcome != Outcome.Open) revert MarketClosed();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (yes) {
            m.yesPool += amount;
            yesStake[court][msg.sender] += amount;
        } else {
            m.noPool += amount;
            noStake[court][msg.sender] += amount;
        }
        emit Bet(court, msg.sender, yes, amount);
    }

    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VERDICT_TYPEHASH, v.court, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// Anyone may submit; only the relayer's signature counts. Closes betting for good.
    function settle(Verdict calldata v, uint8 sigV, bytes32 r, bytes32 s) external {
        if (markets[v.court].outcome != Outcome.Open) revert MarketClosed();
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(verdictDigest(v), sigV, r, s);
        if (signer == address(0) || signer != relayer) revert BadSignature();
        _settle(v);
    }

    /// Anyone may submit a Wormhole VAA of the court's verdict, posted on Solana by saring_wormhole.
    function settleWithVaa(bytes calldata vaa) external {
        _settle(verdictFromVaa(vaa));
    }

    function _settle(Verdict memory v) internal {
        Market storage m = markets[v.court];
        if (m.outcome != Outcome.Open) revert MarketClosed();

        Outcome o;
        if (v.incomplete || v.yes == v.no) o = Outcome.Refund;
        else o = v.yes > v.no ? Outcome.Yes : Outcome.No;
        // Nobody backed the winning side: nothing to split, refund everyone.
        if ((o == Outcome.Yes && m.yesPool == 0) || (o == Outcome.No && m.noPool == 0)) o = Outcome.Refund;
        m.outcome = o;
        emit Settled(v.court, o, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot);
    }

    function claimable(bytes32 court, address who) public view returns (uint256) {
        Market storage m = markets[court];
        uint256 y = yesStake[court][who];
        uint256 n = noStake[court][who];
        if (m.outcome == Outcome.Refund) return y + n;
        uint256 total = m.yesPool + m.noPool;
        if (m.outcome == Outcome.Yes) return y == 0 ? 0 : (y * total) / m.yesPool;
        if (m.outcome == Outcome.No) return n == 0 ? 0 : (n * total) / m.noPool;
        return 0;
    }

    function claim(bytes32 court) external returns (uint256 amount) {
        if (markets[court].outcome == Outcome.Open) revert NotSettled();
        amount = claimable(court, msg.sender);
        if (amount == 0) revert NothingToClaim();
        yesStake[court][msg.sender] = 0;
        noStake[court][msg.sender] = 0;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(court, msg.sender, amount);
    }
}
