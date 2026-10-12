//! Conflict-blind jury circuits (v3). One packed, MXE-encrypted court state holds:
//! who holds a position in the disputed market, who sits on the jury, each juror's
//! latest ballot and each seat's secret ballot key. `resolve_v3` drops every juror
//! who also holds a position and reveals only the tallies, how many jurors were
//! excluded, and whether any slot overflowed. The chain never sees which jurors.
//!
//! Ballot keys (MACI-style, with MPC in place of the coordinator): a ballot only
//! counts if it carries the seat's current key, and a juror can rotate the key in
//! the same ballot. A juror who hands a briber the old key has handed over nothing,
//! and the briber cannot tell. Ballots with a wrong or stale key are ignored silently.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Position-holder slots (the demo Panta market has 42).
    const H: usize = 48;
    /// Juror slots.
    const J: usize = 8;
    /// Identities recorded per `record_positions_v3` call.
    const B: usize = 6;
    /// Layout: [0..H) holder ids | [H..H+J) juror ids | [H+J..H+2J) ballots
    /// (0 none, 1 yes, 2 no) | [H+2J..H+3J) seat keys | [F] overflow flag.
    /// Id 0 marks an empty slot; key 0 is never valid.
    const F: usize = H + 3 * J;
    // ponytail: u32 ids/keys keep the state at ~13 ciphertexts; widen to u64+ for mainnet.
    type Court = Pack<[u32; 73]>;

    pub struct Seat {
        id: u32,
        key: u32,
    }

    pub struct Holders {
        ids: [u32; B],
    }

    pub struct Ballot {
        id: u32,
        key: u32,
        /// 0 keeps the current key; anything else replaces it.
        new_key: u32,
        yes: bool,
    }

    #[instruction]
    pub fn init_court_v3() -> Enc<Mxe, Court> {
        Mxe::get().from_arcis(Pack::new([0u32; 73]))
    }

    /// Seats a juror with their own secret key in the first empty jury slot.
    /// Already-seated ids are ignored; a full jury sets the overflow flag.
    #[instruction]
    pub fn add_juror_v3(input: Enc<Shared, Seat>, court: Enc<Mxe, Court>) -> Enc<Mxe, Court> {
        let seat = input.to_arcis();
        let mut s = court.to_arcis().unpack();
        let mut placed = seat.id == 0 || seat.key == 0;
        for j in 0..J {
            placed = placed || s[H + j] == seat.id;
        }
        for j in 0..J {
            let empty = s[H + j] == 0;
            if empty && !placed {
                s[H + j] = seat.id;
                s[H + 2 * J + j] = seat.key;
            }
            placed = placed || empty;
        }
        if !placed {
            s[F] = 1;
        }
        court.owner.from_arcis(Pack::new(s))
    }

    /// Records up to B identities that hold a position in the disputed market
    /// (unused entries are 0). Duplicates are ignored; a full table sets overflow.
    #[instruction]
    pub fn record_positions_v3(
        input: Enc<Shared, Holders>,
        court: Enc<Mxe, Court>,
    ) -> Enc<Mxe, Court> {
        let ids = input.to_arcis().ids;
        let mut s = court.to_arcis().unpack();
        for b in 0..B {
            let id = ids[b];
            let mut placed = id == 0;
            for k in 0..H {
                placed = placed || s[k] == id;
            }
            for k in 0..H {
                let empty = s[k] == 0;
                if empty && !placed {
                    s[k] = id;
                }
                placed = placed || empty;
            }
            if !placed {
                s[F] = 1;
            }
        }
        court.owner.from_arcis(Pack::new(s))
    }

    /// Casts or overwrites a ballot, only if `key` matches the seat's current key.
    /// A non-zero `new_key` rotates the key in the same step.
    #[instruction]
    pub fn cast_v3(input: Enc<Shared, Ballot>, court: Enc<Mxe, Court>) -> Enc<Mxe, Court> {
        let b = input.to_arcis();
        let mut s = court.to_arcis().unpack();
        let v = if b.yes { 1u32 } else { 2u32 };
        for j in 0..J {
            let ok = b.id != 0 && b.key != 0 && s[H + j] == b.id && s[H + 2 * J + j] == b.key;
            if ok {
                s[H + J + j] = v;
            }
            if ok && b.new_key != 0 {
                s[H + 2 * J + j] = b.new_key;
            }
        }
        court.owner.from_arcis(Pack::new(s))
    }

    /// Tallies ballots from conflict-free jurors only.
    /// Reveals (yes, no, excluded, incomplete): `incomplete` means a slot overflowed,
    /// so the conflict check may have missed someone and the verdict should not settle.
    #[instruction]
    pub fn resolve_v3(court: Enc<Mxe, Court>) -> (u8, u8, u8, bool) {
        let s = court.to_arcis().unpack();
        let mut yes = 0u8;
        let mut no = 0u8;
        let mut excluded = 0u8;
        for j in 0..J {
            let juror = s[H + j];
            let ballot = s[H + J + j];
            let mut conflicted = false;
            for k in 0..H {
                conflicted = conflicted || (s[k] == juror && juror != 0);
            }
            if ballot != 0 && conflicted {
                excluded += 1;
            }
            if ballot == 1 && !conflicted {
                yes += 1;
            }
            if ballot == 2 && !conflicted {
                no += 1;
            }
        }
        let incomplete = s[F] != 0;
        (yes.reveal(), no.reveal(), excluded.reveal(), incomplete.reveal())
    }
}
