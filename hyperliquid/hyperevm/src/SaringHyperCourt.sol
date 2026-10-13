// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "saring-wormhole/SaringWormhole.sol";

/// HyperEVM -> HyperCore action queue (hyperliquid-docs, "Interacting with HyperCore").
interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// @title SaringHyperCourt
/// @notice A Saring verdict for a HIP-4 outcome, settled on HyperEVM with no Hyperliquid permission needed,
///         and acted on directly on HyperCore:
///         - a disputer posts a HYPE bond on HyperEVM; the contract bridges it to its own HyperCore spot account
///           (native HYPE -> 0x2222..2222 credits msg.sender on Core);
///         - the verdict arrives as an EIP-712 attestation by the Saring relayer (same type as tempo/SaringMarket)
///           or as a Wormhole VAA from the saring_wormhole emitter (Wormhole core is live on HyperEVM testnet);
///         - on settlement the contract stamps HyperCore's L1 block and the HYPE oracle price (read precompiles),
///           checks its own Core balance, and returns the bond on HyperCore via CoreWriter spotSend (action 6)
///           if the disputer called it right (or the verdict is void);
///         - `settleFraction(outcome)` is what a HIP-4 deployer's keeper feeds into `outcomeDeploy settleOutcome`.
contract SaringHyperCourt is SaringWormhole {
    enum Result { Open, Yes, No, Void }

    struct Market {
        bytes32 court;       // Saring court on Solana devnet bound to this HIP-4 outcome
        bool inQuestion;     // question outcomes may only settle to 0 or 1 (HIP-4 deployer rules)
        Result result;
        address disputer;
        bool disputerYes;
        uint64 bondWei;      // HYPE in HyperCore wei (8 decimals)
        uint64 l1Block;      // HyperCore block at settlement
        uint64 hypeOraclePx; // HYPE perp oracle price at settlement (raw precompile units)
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 court,uint8 yes,uint8 no,uint8 excluded,bool incomplete,uint64 resolvedSlot)"
    );
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address public constant HYPE_SYSTEM = 0x2222222222222222222222222222222222222222;
    address public constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address public constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address public constant L1_BLOCK = 0x0000000000000000000000000000000000000809;
    address public constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;
    uint256 public constant EVM_PER_CORE_WEI = 1e10; // HYPE: 18 EVM decimals, 8 Core weiDecimals
    uint24 private constant SPOT_SEND = 6;

    address public immutable owner;
    address public immutable relayer; // address(0) = VAA-only
    uint64 public immutable hypeToken; // HyperCore spot token index of HYPE (testnet 1105)
    uint32 public immutable hypePerp;  // perp index of HYPE for the oracle stamp (testnet 135)
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(uint32 => Market) public markets; // keyed by HIP-4 outcome id

    event Opened(uint32 indexed outcome, bytes32 court, bool inQuestion);
    event Disputed(uint32 indexed outcome, address indexed disputer, bool claimYes, uint64 bondWei);
    event Settled(uint32 indexed outcome, Result result, uint8 yes, uint8 no, uint8 excluded, bool incomplete, uint64 resolvedSlot, uint64 l1Block, uint64 hypeOraclePx);
    event BondReturnedOnCore(uint32 indexed outcome, address indexed disputer, uint64 bondWei);
    event BondForfeited(uint32 indexed outcome, address indexed disputer, uint64 bondWei);

    error NotOwner();
    error AlreadyOpen();
    error NotOpen();
    error NotSettled();
    error AlreadyDisputed();
    error BadBond();
    error NoCoreAccount();
    error WrongCourt();
    error BadSignature();
    error BridgeFailed();
    error InsufficientCoreBalance(uint64 have, uint64 need);
    error PrecompileFailed(address precompile);
    error NoFraction();

    constructor(address relayer_, IWormhole wormhole_, bytes32 emitter_, uint64 hypeToken_, uint32 hypePerp_)
        SaringWormhole(wormhole_, emitter_)
    {
        _requireVaaOnly(wormhole_, relayer_);
        owner = msg.sender;
        relayer = relayer_;
        hypeToken = hypeToken_;
        hypePerp = hypePerp_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SaringHyperCourt"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// Binds a HIP-4 outcome to the Saring court that judges it.
    function open(uint32 outcome, bytes32 court, bool inQuestion) external {
        if (msg.sender != owner) revert NotOwner();
        if (court == bytes32(0) || markets[outcome].court != bytes32(0)) revert AlreadyOpen();
        markets[outcome].court = court;
        markets[outcome].inQuestion = inQuestion;
        emit Opened(outcome, court, inQuestion);
    }

    /// Post a HYPE bond claiming the outcome resolves YES or NO. The bond moves to this contract's HyperCore account.
    /// The disputer must already exist on HyperCore, so the refund spotSend can never be stuck on a missing account.
    function dispute(uint32 outcome, bool claimYes) external payable {
        Market storage m = markets[outcome];
        if (m.court == bytes32(0) || m.result != Result.Open) revert NotOpen();
        if (m.disputer != address(0)) revert AlreadyDisputed(); // ponytail: one disputer per outcome
        if (msg.value == 0 || msg.value % EVM_PER_CORE_WEI != 0 || msg.value / EVM_PER_CORE_WEI > type(uint64).max) revert BadBond();
        if (!coreUserExists(msg.sender)) revert NoCoreAccount();
        m.disputer = msg.sender;
        m.disputerYes = claimYes;
        m.bondWei = uint64(msg.value / EVM_PER_CORE_WEI);
        (bool ok,) = HYPE_SYSTEM.call{value: msg.value}("");
        if (!ok) revert BridgeFailed();
        emit Disputed(outcome, msg.sender, claimYes, m.bondWei);
    }

    function verdictDigest(Verdict memory v) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VERDICT_TYPEHASH, v.court, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// Anyone may submit; only the relayer's signature counts.
    function settle(uint32 outcome, Verdict calldata v, uint8 sigV, bytes32 r, bytes32 s) external {
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(verdictDigest(v), sigV, r, s);
        if (signer == address(0) || signer != relayer) revert BadSignature();
        _settle(outcome, v);
    }

    /// Anyone may submit a guardian-signed VAA from the saring_wormhole emitter: no Saring key involved.
    function settleWithVaa(uint32 outcome, bytes calldata vaa) external {
        _settle(outcome, verdictFromVaa(vaa));
    }

    function _settle(uint32 outcome, Verdict memory v) internal {
        Market storage m = markets[outcome];
        if (m.court == bytes32(0) || m.result != Result.Open) revert NotOpen();
        if (v.court != m.court) revert WrongCourt();

        Result res = v.incomplete || v.yes == v.no ? Result.Void : (v.yes > v.no ? Result.Yes : Result.No);
        m.result = res;
        m.l1Block = l1BlockNumber();
        m.hypeOraclePx = hypeOraclePx();
        emit Settled(outcome, res, v.yes, v.no, v.excluded, v.incomplete, v.resolvedSlot, m.l1Block, m.hypeOraclePx);

        if (m.disputer == address(0)) return;
        if (res == Result.Void || (res == Result.Yes) == m.disputerYes) {
            uint64 have = coreSpotBalance(address(this), hypeToken);
            if (have < m.bondWei) revert InsufficientCoreBalance(have, m.bondWei);
            ICoreWriter(CORE_WRITER).sendRawAction(
                abi.encodePacked(uint8(1), SPOT_SEND, abi.encode(m.disputer, hypeToken, m.bondWei))
            );
            emit BondReturnedOnCore(outcome, m.disputer, m.bondWei);
        } else {
            // ponytail: forfeited bond stays on this contract's Core account; juror payout is a later spotSend.
            emit BondForfeited(outcome, m.disputer, m.bondWei);
        }
    }

    /// HIP-4 settleFraction scaled by 1e18: YES 1e18, NO 0, tie/incomplete 0.5e18 for a standalone outcome.
    /// A question outcome may only settle to 0 or 1, so a void verdict there reverts (re-run or escalate).
    function settleFraction(uint32 outcome) external view returns (uint256) {
        Market storage m = markets[outcome];
        if (m.result == Result.Open) revert NotSettled();
        if (m.result == Result.Yes) return 1e18;
        if (m.result == Result.No) return 0;
        if (m.inQuestion) revert NoFraction();
        return 5e17;
    }

    // ---- HyperCore read precompiles ----

    function _read(address p, bytes memory input) internal view returns (bytes memory out) {
        bool ok;
        // Invalid precompile input burns all gas passed in: cap it.
        (ok, out) = p.staticcall{gas: 100_000}(input);
        if (!ok) revert PrecompileFailed(p);
    }

    function l1BlockNumber() public view returns (uint64) {
        return abi.decode(_read(L1_BLOCK, ""), (uint64));
    }

    function hypeOraclePx() public view returns (uint64) {
        return abi.decode(_read(ORACLE_PX, abi.encode(hypePerp)), (uint64));
    }

    /// Spot balance available on HyperCore (total - hold), in Core wei.
    function coreSpotBalance(address user, uint64 token) public view returns (uint64) {
        (uint64 total, uint64 hold,) = abi.decode(_read(SPOT_BALANCE, abi.encode(user, token)), (uint64, uint64, uint64));
        return total - hold;
    }

    function coreUserExists(address user) public view returns (bool) {
        return abi.decode(_read(CORE_USER_EXISTS, abi.encode(user)), (bool));
    }
}
