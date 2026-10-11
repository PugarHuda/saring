//! Conflict-blind jury circuits. One packed, MXE-encrypted court state holds:
//! who holds a position in the disputed market, who sits on the jury, and each
//! juror's latest ballot. `resolve` drops every juror who also holds a position,
//! then reveals only the tallies and how many jurors were excluded — never who.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Position-holder slots.
    const H: usize = 16;
    /// Juror slots.
    const J: usize = 8;
    /// Layout: [0..H) holder ids, [H..H+J) juror ids, [H+J..H+2J) ballots
    /// (0 = none, 1 = yes, 2 = no). Id 0 marks an empty slot.
    // ponytail: u32 ids keep the state at a few ciphertexts; move to u128 (SAS-derived) for mainnet.
    type Court = Pack<[u32; 32]>;

    pub struct Identity {
        id: u32,
    }

    pub struct Ballot {
        id: u32,
        yes: bool,
    }

    #[instruction]
    pub fn init_court() -> Enc<Mxe, Court> {
        Mxe::get().from_arcis(Pack::new([0u32; 32]))
    }

    /// Seats a juror in the first empty jury slot.
    #[instruction]
    pub fn add_juror(input: Enc<Shared, Identity>, court: Enc<Mxe, Court>) -> Enc<Mxe, Court> {
        let id = input.to_arcis().id;
        let mut s = court.to_arcis().unpack();
        let mut placed = id == 0;
        for j in 0..J {
            let empty = s[H + j] == 0;
            if empty && !placed {
                s[H + j] = id;
            }
            placed = placed || empty;
        }
        court.owner.from_arcis(Pack::new(s))
    }

    /// Records that `id` holds a position in the disputed market (called on trade).
    #[instruction]
    pub fn record_position(
        input: Enc<Shared, Identity>,
        court: Enc<Mxe, Court>,
    ) -> Enc<Mxe, Court> {
        let id = input.to_arcis().id;
        let mut s = court.to_arcis().unpack();
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
        court.owner.from_arcis(Pack::new(s))
    }

    /// Casts or overwrites a ballot. Only the latest ballot per juror counts, so a
    /// juror can always re-vote after showing a briber a "receipt".
    #[instruction]
    pub fn cast(input: Enc<Shared, Ballot>, court: Enc<Mxe, Court>) -> Enc<Mxe, Court> {
        let b = input.to_arcis();
        let mut s = court.to_arcis().unpack();
        let v = if b.yes { 1u32 } else { 2u32 };
        for j in 0..J {
            if s[H + j] == b.id && b.id != 0 {
                s[H + J + j] = v;
            }
        }
        court.owner.from_arcis(Pack::new(s))
    }

    /// Tallies ballots from conflict-free jurors only. Reveals (yes, no, excluded).
    #[instruction]
    pub fn resolve(court: Enc<Mxe, Court>) -> (u8, u8, u8) {
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
        (yes.reveal(), no.reveal(), excluded.reveal())
    }
}
