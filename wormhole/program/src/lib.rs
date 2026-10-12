//! saring_wormhole: reads a resolved Saring CourtAccount and posts its verdict as a
//! Wormhole message. The emitter is this program's PDA ["emitter"], so a VAA from it can
//! only carry what this code read from an account owned by the Saring program.
//!
//! Payload (45 bytes): 0x01 | court[32] | yes u8 | no u8 | excluded u8 | incomplete u8 | slot u64 BE
//!
//! Accounts: payer(s,w) court bridge(w) message(s,w) emitter sequence(w) fee_collector(w)
//!           clock rent system_program wormhole_program
#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

pub const SARING: Pubkey = pubkey!("3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy");
pub const WORMHOLE: Pubkey = pubkey!("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const COURT_DISC: [u8; 8] = [7, 119, 99, 132, 122, 108, 213, 97];
const STATE_LEN: usize = 13;
// disc + bump + state + nonce u128 + id u32 + authority; then market: String (u32 len + bytes)
const MARKET_OFF: usize = 8 + 1 + 32 * STATE_LEN + 16 + 4 + 32;

entrypoint!(process);

/// Returns (yes, no, excluded, incomplete) of a resolved court, or an error.
pub fn read_verdict(owner: &Pubkey, d: &[u8]) -> Result<[u8; 4], ProgramError> {
    if *owner != SARING || d.len() < MARKET_OFF + 4 || d[..8] != COURT_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    let len = u32::from_le_bytes(d[MARKET_OFF..MARKET_OFF + 4].try_into().unwrap()) as usize;
    let f = MARKET_OFF + 4 + len; // resolved, yes, no, excluded, pending, incomplete
    if d.len() < f + 6 {
        return Err(ProgramError::InvalidAccountData);
    }
    if d[f] != 1 || d[f + 4] != 0 {
        return Err(ProgramError::Custom(1)); // not resolved, or a computation is pending
    }
    Ok([d[f + 1], d[f + 2], d[f + 3], d[f + 5]])
}

fn process(program_id: &Pubkey, accs: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let [payer, court, bridge, message, emitter, sequence, fee_collector, clock, rent, system, wormhole] = accs else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if *wormhole.key != WORMHOLE || *system.key != Pubkey::default() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (emitter_key, bump) = Pubkey::find_program_address(&[b"emitter"], program_id);
    if *emitter.key != emitter_key {
        return Err(ProgramError::InvalidSeeds);
    }
    let v = read_verdict(court.owner, &court.try_borrow_data()?)?;

    // Core bridge checks fee_collector grew by >= fee. BridgeData: gs_index u32, last_lamports u64, gs_expiry u32, fee u64.
    let fee = u64::from_le_bytes(bridge.try_borrow_data()?[16..24].try_into().unwrap());
    if fee > 0 {
        // System transfer (tag 2 | lamports u64 LE); system_instruction left solana-program in 3.0.
        let mut d = vec![2u8, 0, 0, 0];
        d.extend_from_slice(&fee.to_le_bytes());
        let t = Instruction { program_id: *system.key, accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*fee_collector.key, false)], data: d };
        invoke(&t, &[payer.clone(), fee_collector.clone(), system.clone()])?;
    }

    let mut payload = Vec::with_capacity(45);
    payload.push(1u8);
    payload.extend_from_slice(court.key.as_ref());
    payload.extend_from_slice(&v);
    payload.extend_from_slice(&Clock::get()?.slot.to_be_bytes());

    // Legacy core bridge PostMessage: tag 1 | nonce u32 | payload Vec<u8> | consistency (1 = Finalized), borsh.
    let mut data = vec![1u8, 0, 0, 0, 0];
    data.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    data.extend_from_slice(&payload);
    data.push(1);

    let ix = Instruction {
        program_id: WORMHOLE,
        accounts: vec![
            AccountMeta::new(*bridge.key, false),
            AccountMeta::new(*message.key, true),
            AccountMeta::new_readonly(emitter_key, true),
            AccountMeta::new(*sequence.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*fee_collector.key, false),
            AccountMeta::new_readonly(*clock.key, false),
            AccountMeta::new_readonly(*rent.key, false),
            AccountMeta::new_readonly(*system.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[bridge.clone(), message.clone(), emitter.clone(), sequence.clone(), payer.clone(), fee_collector.clone(), clock.clone(), rent.clone(), system.clone()],
        &[&[b"emitter", &[bump]]],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn court(resolved: u8, pending: u8) -> Vec<u8> {
        let mut d = COURT_DISC.to_vec();
        d.resize(MARKET_OFF, 0);
        d.extend_from_slice(&3u32.to_le_bytes());
        d.extend_from_slice(b"abc");
        d.extend_from_slice(&[resolved, 0, 1, 1, pending, 0, 1, 0]);
        d.extend_from_slice(&[0u8; 8]);
        d
    }

    #[test]
    fn verdict_checks() {
        assert_eq!(read_verdict(&SARING, &court(1, 0)).unwrap(), [0, 1, 1, 0]);
        assert!(read_verdict(&SARING, &court(0, 0)).is_err());
        assert!(read_verdict(&SARING, &court(1, 1)).is_err());
        assert!(read_verdict(&Pubkey::new_unique(), &court(1, 0)).is_err());
        let mut bad = court(1, 0);
        bad[0] ^= 1;
        assert!(read_verdict(&SARING, &bad).is_err());
    }
}
