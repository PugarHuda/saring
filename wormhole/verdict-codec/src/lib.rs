//! The Saring verdict payload, one definition for every VM that touches it:
//! the Solana emitter (`wormhole/program`, SBF), the Stylus verifier (`arbitrum/stylus`, WASM),
//! and, by hand, `SaringWormhole.verdictFromVaa` in Solidity.
//!
//! Layout (45 bytes): 0x01 | court[32] | yes u8 | no u8 | excluded u8 | incomplete u8 | slot u64 BE
#![no_std]

pub const VERSION: u8 = 1;
pub const LEN: usize = 45;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    /// Saring court account pubkey on Solana.
    pub court: [u8; 32],
    pub yes: u8,
    pub no: u8,
    /// Ballots dropped inside MPC because the juror holds a position.
    pub excluded: u8,
    /// The conflict check overflowed: the verdict is void.
    pub incomplete: bool,
    /// Solana slot at which the resolved court was read.
    pub slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Length,
    Version,
    /// `incomplete` byte other than 0 or 1.
    Flag,
}

impl Verdict {
    /// Same bytes as `wormhole/program` posts (push 1, court, [yes, no, excluded, incomplete], slot BE).
    pub fn encode(&self) -> [u8; LEN] {
        let mut p = [0u8; LEN];
        p[0] = VERSION;
        p[1..33].copy_from_slice(&self.court);
        p[33] = self.yes;
        p[34] = self.no;
        p[35] = self.excluded;
        p[36] = self.incomplete as u8;
        p[37..].copy_from_slice(&self.slot.to_be_bytes());
        p
    }

    pub fn decode(p: &[u8]) -> Result<Self, Error> {
        if p.len() != LEN {
            return Err(Error::Length);
        }
        if p[0] != VERSION {
            return Err(Error::Version);
        }
        if p[36] > 1 {
            return Err(Error::Flag);
        }
        let mut court = [0u8; 32];
        court.copy_from_slice(&p[1..33]);
        let mut slot = [0u8; 8];
        slot.copy_from_slice(&p[37..]);
        Ok(Verdict { court, yes: p[33], no: p[34], excluded: p[35], incomplete: p[36] == 1, slot: u64::from_be_bytes(slot) })
    }

    /// Kleros-style ruling, as in `SaringArbitratorV2`: 1 = YES majority, 2 = NO majority, 0 = refused (tie or incomplete).
    pub fn ruling(&self) -> u8 {
        if self.incomplete || self.yes == self.no {
            0
        } else if self.yes > self.no {
            1
        } else {
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The payload (last 45 bytes) of the real guardian-signed VAA the deployed `saring_wormhole` program
    /// emitted for court 24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb (wormhole/out/vaa-24gQ...json, Solana tx 5WtYWwEu...).
    const ONCHAIN: [u8; LEN] = [
        0x01, 0x0f, 0xcc, 0xfd, 0x5d, 0x89, 0x27, 0x99, 0x2d, 0x06, 0xab, 0x54, 0x68, 0xa7, 0x23, 0x2e, 0xd5, 0x28, 0x07, 0x18,
        0xe3, 0x4b, 0xf4, 0x49, 0xa0, 0xac, 0xbb, 0xf6, 0x6a, 0x36, 0xaa, 0x5f, 0x04, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x1e, 0x6a, 0xa1, 0xe3,
    ];

    /// The deployed emitter's bytes decode and re-encode identically: switching `wormhole/program` to this crate
    /// changes no output, so it needs no redeploy.
    #[test]
    fn onchain_payload_roundtrips() {
        let v = Verdict::decode(&ONCHAIN).unwrap();
        assert_eq!(v.court[..4], [0x0f, 0xcc, 0xfd, 0x5d]);
        assert_eq!((v.yes, v.no, v.excluded, v.incomplete, v.slot), (0, 1, 1, false, 0x1e6a_a1e3));
        assert_eq!(v.ruling(), 2);
        assert_eq!(v.encode(), ONCHAIN);
    }

    /// Mirrors the emitter's construction in wormhole/program/src/lib.rs `process` (Vec push/extend) byte for byte.
    #[test]
    fn matches_emitter_construction() {
        let (court, tally, slot) = ([7u8; 32], [3u8, 2, 1, 1], 510_221_975u64);
        let mut emitter = [0u8; LEN];
        emitter[0] = 1;
        emitter[1..33].copy_from_slice(&court);
        emitter[33..37].copy_from_slice(&tally);
        emitter[37..].copy_from_slice(&slot.to_be_bytes());
        let v = Verdict { court, yes: 3, no: 2, excluded: 1, incomplete: true, slot };
        assert_eq!(v.encode(), emitter);
        assert_eq!(v.ruling(), 0);
    }

    #[test]
    fn rejects_and_rulings() {
        assert_eq!(Verdict::decode(&ONCHAIN[..44]), Err(Error::Length));
        let mut p = ONCHAIN;
        p[0] = 2;
        assert_eq!(Verdict::decode(&p), Err(Error::Version));
        p = ONCHAIN;
        p[36] = 2;
        assert_eq!(Verdict::decode(&p), Err(Error::Flag));
        let mut v = Verdict::decode(&ONCHAIN).unwrap();
        v.yes = 2;
        assert_eq!(v.ruling(), 1);
        v.yes = 1;
        assert_eq!(v.ruling(), 0);
    }
}
