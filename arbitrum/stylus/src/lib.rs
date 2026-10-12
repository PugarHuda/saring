//! SaringStylusVerifier: the Saring verdict VAA checked in WASM on Arbitrum.
//!
//! `submitVaa(vaa)` asks the Arbitrum Sepolia Wormhole core bridge to verify the guardian signatures
//! (`parseAndVerifyVM`), checks the emitter (Solana, saring_wormhole PDA), decodes the 45-byte payload with
//! `saring-verdict-codec` (the same crate the Solana side builds against) and records it.
//! `verdictOf(court)` returns what was recorded, plus the Kleros-style ruling (1 YES, 2 NO, 0 refused).
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use alloy_sol_types::{sol, SolCall};
use saring_verdict_codec::Verdict;
use stylus_sdk::{
    abi::Bytes,
    alloy_primitives::{address, b256, Address, FixedBytes},
    call::static_call,
    stylus_core::calls::Call,
    prelude::*,
};

/// Wormhole core bridge on Arbitrum Sepolia (the constructor argument for a Sepolia deploy).
pub const CORE: Address = address!("6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35");
/// saring_wormhole emitter PDA 6hrzcMmM16aUh5D1YkaVvPoQ2q532Acb2PC8yU935ABq on Solana.
pub const EMITTER: FixedBytes<32> = b256!("54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238");
pub const SOLANA_CHAIN_ID: u16 = 1;

sol! {
    // wormhole-foundation/wormhole ethereum/contracts/interfaces/IWormhole.sol (the subset we call)
    struct Signature { bytes32 r; bytes32 s; uint8 v; uint8 guardianIndex; }
    struct VM {
        uint8 version; uint32 timestamp; uint32 nonce; uint16 emitterChainId; bytes32 emitterAddress;
        uint64 sequence; uint8 consistencyLevel; bytes payload; uint32 guardianSetIndex; Signature[] signatures; bytes32 hash;
    }
    function parseAndVerifyVM(bytes encodedVM) external view returns (VM vm, bool valid, string reason);

    event VerdictRecorded(bytes32 indexed court, uint8 yes, uint8 no, uint8 excluded, bool incomplete, uint64 slot, uint8 ruling);

    error BadVaa(string reason);
    error WrongEmitter();
    error BadPayload();
}

#[derive(SolidityError)]
pub enum VerifierError {
    BadVaa(BadVaa),
    WrongEmitter(WrongEmitter),
    BadPayload(BadPayload),
}

sol_storage! {
    pub struct StoredVerdict {
        bool known;
        uint8 yes;
        uint8 no;
        uint8 excluded;
        bool incomplete;
        uint64 slot;
    }

    #[entrypoint]
    pub struct SaringStylusVerifier {
        address core;      // Wormhole core bridge
        bytes32 emitter;   // saring_wormhole emitter PDA
        mapping(bytes32 => StoredVerdict) verdicts;
    }
}

type VerdictTuple = (bool, u8, u8, u8, bool, u64, u8);

#[public]
impl SaringStylusVerifier {
    #[constructor]
    pub fn constructor(&mut self, core: Address, emitter: FixedBytes<32>) {
        self.core.set(core);
        self.emitter.set(emitter);
    }

    /// Anyone may submit. Verifies the VAA through the core bridge and records the verdict (a later slot replaces an earlier one).
    pub fn submit_vaa(&mut self, vaa: Bytes) -> Result<u8, VerifierError> {
        let data = parseAndVerifyVMCall { encodedVM: vaa.0.into() }.abi_encode();
        let ret = static_call(self.vm(), Call::new(), self.core.get(), &data).map_err(|_| VerifierError::BadVaa(BadVaa { reason: String::from("core call failed") }))?;
        let r = parseAndVerifyVMCall::abi_decode_returns(&ret).map_err(|_| VerifierError::BadVaa(BadVaa { reason: String::from("bad core return") }))?;
        if !r.valid {
            return Err(VerifierError::BadVaa(BadVaa { reason: r.reason }));
        }
        if r.vm.emitterChainId != SOLANA_CHAIN_ID || r.vm.emitterAddress != self.emitter.get() {
            return Err(VerifierError::WrongEmitter(WrongEmitter {}));
        }
        let v = Verdict::decode(&r.vm.payload).map_err(|_| VerifierError::BadPayload(BadPayload {}))?;
        let court = FixedBytes::<32>::from(v.court);
        let mut s = self.verdicts.setter(court);
        if !s.known.get() || v.slot > s.slot.get().to::<u64>() {
            s.known.set(true);
            s.yes.set(stylus_sdk::alloy_primitives::Uint::from(v.yes));
            s.no.set(stylus_sdk::alloy_primitives::Uint::from(v.no));
            s.excluded.set(stylus_sdk::alloy_primitives::Uint::from(v.excluded));
            s.incomplete.set(v.incomplete);
            s.slot.set(stylus_sdk::alloy_primitives::Uint::from(v.slot));
            self.vm().log(VerdictRecorded { court, yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, slot: v.slot, ruling: v.ruling() });
        }
        Ok(v.ruling())
    }

    /// (known, yes, no, excluded, incomplete, slot, ruling)
    pub fn verdict_of(&self, court: FixedBytes<32>) -> VerdictTuple {
        let s = self.verdicts.getter(court);
        if !s.known.get() {
            return (false, 0, 0, 0, false, 0, 0);
        }
        let v = Verdict { court: court.0, yes: s.yes.get().to(), no: s.no.get().to(), excluded: s.excluded.get().to(), incomplete: s.incomplete.get(), slot: s.slot.get().to() };
        (true, v.yes, v.no, v.excluded, v.incomplete, v.slot, v.ruling())
    }

    /// The shared codec on its own, no VAA: decode a raw 45-byte payload. (court, yes, no, excluded, incomplete, slot, ruling)
    pub fn decode_payload(&self, payload: Bytes) -> Result<(FixedBytes<32>, u8, u8, u8, bool, u64, u8), VerifierError> {
        let v = Verdict::decode(&payload).map_err(|_| VerifierError::BadPayload(BadPayload {}))?;
        Ok((FixedBytes::from(v.court), v.yes, v.no, v.excluded, v.incomplete, v.slot, v.ruling()))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::testing::*;

    /// The real VAA (court 24gQ...YGb, resolved NO) from wormhole/out; its payload is the last 45 bytes.
    const VAA: &str = "010000000001007ff14f4cef032c734b7e12d2e86b2b81dcafc7ab3086174587b5f22785c48109560b58aa7b6ef7f630cff157c7ec6200a97df4e7df408b9594ba9743e409a035016accf8a600000000000154c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238000000000000000020010fccfd5d8927992d06ab5468a7232ed5280718e34bf449a0acbbf66a36aa5f0400010100000000001e6aa1e3";
    const COURT: FixedBytes<32> = b256!("0fccfd5d8927992d06ab5468a7232ed5280718e34bf449a0acbbf66a36aa5f04");

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Mocks the core bridge's answer for `vaa` (the real core is exercised by the Sepolia run).
    fn mock_core(vm: &TestVM, vaa: &[u8], valid: bool, emitter: FixedBytes<32>, payload: Vec<u8>) {
        let call = parseAndVerifyVMCall { encodedVM: vaa.to_vec().into() }.abi_encode();
        let m = VM { emitterChainId: 1, emitterAddress: emitter, payload: payload.into(), version: 1, timestamp: 0, nonce: 0, sequence: 0, consistencyLevel: 1, guardianSetIndex: 0, signatures: Vec::new(), hash: FixedBytes::ZERO };
        let ret = <parseAndVerifyVMCall as SolCall>::abi_encode_returns(&parseAndVerifyVMReturn { vm: m, valid, reason: String::from(if valid { "" } else { "VM signature invalid" }) });
        vm.mock_static_call(CORE, call, Ok(ret));
    }

    #[test]
    fn records_real_vaa_payload() {
        let vm = TestVM::default();
        let mut c = SaringStylusVerifier::from(&vm);
        c.constructor(CORE, EMITTER);
        let vaa = hex(VAA);
        mock_core(&vm, &vaa, true, EMITTER, vaa[vaa.len() - 45..].to_vec());
        assert_eq!(c.verdict_of(COURT).0, false);
        assert_eq!(c.submit_vaa(Bytes(vaa.into())).ok(), Some(2));
        assert_eq!(c.verdict_of(COURT), (true, 0, 1, 1, false, 0x1e6a_a1e3, 2));
    }

    #[test]
    fn rejects() {
        let vm = TestVM::default();
        let mut c = SaringStylusVerifier::from(&vm);
        c.constructor(CORE, EMITTER);
        let vaa = hex(VAA);
        let payload = vaa[vaa.len() - 45..].to_vec();
        mock_core(&vm, &vaa, false, EMITTER, payload.clone());
        assert!(matches!(c.submit_vaa(Bytes(vaa.clone().into())), Err(VerifierError::BadVaa(_))));
        mock_core(&vm, &vaa, true, FixedBytes::ZERO, payload.clone());
        assert!(matches!(c.submit_vaa(Bytes(vaa.clone().into())), Err(VerifierError::WrongEmitter(_))));
        mock_core(&vm, &vaa, true, EMITTER, payload[..44].to_vec());
        assert!(matches!(c.submit_vaa(Bytes(vaa.into())), Err(VerifierError::BadPayload(_))));
        assert_eq!(c.verdict_of(COURT).0, false);
        assert_eq!(c.decode_payload(Bytes(payload.into())).ok().map(|t| (t.0, t.6)), Some((COURT, 2)));
    }
}
