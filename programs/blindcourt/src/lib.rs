//! Saring (codename blindcourt): a conflict-blind jury for prediction-market disputes.
//!
//! Each `CourtAccount` keeps one MXE-encrypted state (see encrypted-ixs): who holds
//! a position in the disputed market, who sits on the jury, each juror's latest
//! ballot and each seat's secret ballot key. Every update happens inside MPC.
//! `resolve` ignores jurors who hold a position and reveals only (yes, no, excluded,
//! incomplete); the chain never sees which jurors were dropped.
//!
//! One computation at a time per court: every queue instruction takes the
//! `pending` lock and its callback releases it, so two MPC jobs never read the same
//! state snapshot and overwrite each other.
//!
//! A minimal pari-mutuel market (`create_market` / `bet` / `claim`) settles on the
//! court's verdict, showing how a venue consumes it from the `CourtAccount` alone.
//!
//! Layout read by circuits via `ArgBuilder::account`: 8-byte discriminator, 1-byte
//! `bump`, then `state` (STATE_LEN x 32-byte ciphertexts) at offset 9.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;

/// Public host for the compiled `.arcis` circuits (GitHub release assets).
const CIRCUIT_BASE_URL: &str = "https://github.com/PugarHuda/saring/releases/download/circuits-v3/";

fn offchain(name: &str, hash: [u8; 32]) -> CircuitSource {
    CircuitSource::OffChain(OffChainCircuitSource {
        source: format!("{CIRCUIT_BASE_URL}{name}.arcis"),
        hash,
    })
}

const COMP_DEF_OFFSET_INIT_COURT: u32 = comp_def_offset("init_court_v3");
const COMP_DEF_OFFSET_ADD_JUROR: u32 = comp_def_offset("add_juror_v3");
const COMP_DEF_OFFSET_RECORD_POSITIONS: u32 = comp_def_offset("record_positions_v3");
const COMP_DEF_OFFSET_CAST: u32 = comp_def_offset("cast_v3");
const COMP_DEF_OFFSET_RESOLVE: u32 = comp_def_offset("resolve_v3");

/// Ciphertexts produced by `Pack<[u32; 73]>`.
pub const STATE_LEN: usize = 13;
const STATE_OFFSET: u32 = 8 + 1;
const STATE_BYTES: u32 = 32 * STATE_LEN as u32;

declare_id!("3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy");

#[arcium_program]
pub mod blindcourt {
    use super::*;

    // Circuits (~450 KB each) are fetched by Arx nodes from the GitHub release and
    // checked against the hash compiled in here.
    pub fn init_init_court_v3_comp_def(ctx: Context<InitInitCourtCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("init_court_v3", circuit_hash!("init_court_v3"))))?;
        Ok(())
    }
    pub fn init_add_juror_v3_comp_def(ctx: Context<InitAddJurorCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("add_juror_v3", circuit_hash!("add_juror_v3"))))?;
        Ok(())
    }
    pub fn init_record_positions_v3_comp_def(ctx: Context<InitRecordPositionsCompDef>) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            Some(offchain("record_positions_v3", circuit_hash!("record_positions_v3"))),
        )?;
        Ok(())
    }
    pub fn init_cast_v3_comp_def(ctx: Context<InitCastCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("cast_v3", circuit_hash!("cast_v3"))))?;
        Ok(())
    }
    pub fn init_resolve_v3_comp_def(ctx: Context<InitResolveCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("resolve_v3", circuit_hash!("resolve_v3"))))?;
        Ok(())
    }

    /// Opens a dispute court for one market and queues `init_court` (empty state).
    pub fn create_court(
        ctx: Context<CreateCourt>,
        computation_offset: u64,
        id: u32,
        market: String,
    ) -> Result<()> {
        require!(market.len() <= MAX_MARKET_LEN, ErrorCode::MarketTooLong);
        let court = &mut ctx.accounts.court_acc;
        court.bump = ctx.bumps.court_acc;
        court.pending = true;
        court.id = id;
        court.authority = ctx.accounts.payer.key();
        court.market = market;
        court.state = [[0; 32]; STATE_LEN];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            ArgBuilder::new().build(),
            vec![InitCourtV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: key, is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_court_v3")]
    pub fn init_court_v3_callback(
        ctx: Context<InitCourtV3Callback>,
        output: SignedComputationOutputs<InitCourtV3Output>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(InitCourtV3Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        ctx.accounts.court_acc.pending = false;
        Ok(())
    }

    /// Seats a juror: encrypted (id, key). The ciphertext can come from the juror's
    /// own browser key, so the authority relays a seat whose ballot key it never sees.
    /// Authority only (stands in for sortition + identity attestation).
    pub fn add_juror(
        ctx: Context<AddJuror>,
        computation_offset: u64,
        _id: u32,
        juror_id: [u8; 32],
        juror_key: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        lock(&mut ctx.accounts.court_acc)?;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u32(juror_id)
            .encrypted_u32(juror_key)
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AddJurorV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: key, is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "add_juror_v3")]
    pub fn add_juror_v3_callback(
        ctx: Context<AddJurorV3Callback>,
        output: SignedComputationOutputs<AddJurorV3Output>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(AddJurorV3Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        ctx.accounts.court_acc.pending = false;
        Ok(())
    }

    /// Records up to 6 encrypted identities as holding a position in this market
    /// (unused entries encrypt 0). Authority only: it mirrors positions read from
    /// the market's chain state (Panta `UserPosition` accounts in the demo).
    // ponytail: authority relays positions; a market program could CPI this on every fill instead.
    pub fn record_positions(
        ctx: Context<RecordPositions>,
        computation_offset: u64,
        _id: u32,
        trader_ids: [[u8; 32]; 6],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.court_acc.authority,
            ErrorCode::InvalidAuthority
        );
        lock(&mut ctx.accounts.court_acc)?;
        let mut args = ArgBuilder::new().x25519_pubkey(pubkey).plaintext_u128(nonce);
        for ct in trader_ids {
            args = args.encrypted_u32(ct);
        }
        let args = args
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RecordPositionsV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: key, is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "record_positions_v3")]
    pub fn record_positions_v3_callback(
        ctx: Context<RecordPositionsV3Callback>,
        output: SignedComputationOutputs<RecordPositionsV3Output>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(RecordPositionsV3Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        ctx.accounts.court_acc.pending = false;
        Ok(())
    }

    /// Casts or overwrites an encrypted ballot (id, key, new_key, yes). It only counts
    /// inside MPC if `key` is the seat's current key; a non-zero `new_key` rotates it.
    /// Any payer can relay it, so the signer reveals nothing about who the juror is.
    pub fn cast(
        ctx: Context<Cast>,
        computation_offset: u64,
        _id: u32,
        juror_id: [u8; 32],
        key: [u8; 32],
        new_key: [u8; 32],
        yes: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        lock(&mut ctx.accounts.court_acc)?;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u32(juror_id)
            .encrypted_u32(key)
            .encrypted_u32(new_key)
            .encrypted_bool(yes)
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CastV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: key, is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "cast_v3")]
    pub fn cast_v3_callback(
        ctx: Context<CastV3Callback>,
        output: SignedComputationOutputs<CastV3Output>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(CastV3Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        ctx.accounts.court_acc.pending = false;
        emit!(BallotEvent { court: ctx.accounts.court_acc.key() });
        Ok(())
    }

    /// Tallies conflict-free ballots. Authority only.
    pub fn resolve(ctx: Context<Resolve>, computation_offset: u64, _id: u32) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.court_acc.authority,
            ErrorCode::InvalidAuthority
        );
        lock(&mut ctx.accounts.court_acc)?;
        let args = ArgBuilder::new()
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ResolveV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: key, is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "resolve_v3")]
    pub fn resolve_v3_callback(
        ctx: Context<ResolveV3Callback>,
        output: SignedComputationOutputs<ResolveV3Output>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ResolveV3Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let court = &mut ctx.accounts.court_acc;
        require!(!court.resolved, ErrorCode::AlreadyResolved);
        court.pending = false;
        court.resolved = true;
        court.yes = o.field_0;
        court.no = o.field_1;
        court.excluded = o.field_2;
        court.incomplete = o.field_3;
        emit!(VerdictEvent {
            court: court.key(),
            yes: court.yes,
            no: court.no,
            excluded: court.excluded,
            incomplete: court.incomplete,
        });
        Ok(())
    }

    /// Releases the lock after an aborted computation (its callback never cleared it).
    /// Authority only.
    pub fn reset_pending(ctx: Context<ResetPending>, _id: u32) -> Result<()> {
        ctx.accounts.court_acc.pending = false;
        Ok(())
    }

    // ---------- market: settles on the court's verdict ----------

    /// Opens a YES/NO pari-mutuel market that settles on `court`'s verdict.
    pub fn create_market(ctx: Context<CreateMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.court_acc = ctx.accounts.court_acc.key();
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Stakes `lamports` on YES (`yes = true`) or NO while the court is unresolved.
    /// Bets are public; the court authority mirrors bettors into the court with
    /// `record_positions`, so a bettor who also sits on the jury is excluded.
    pub fn bet(ctx: Context<Bet>, yes: bool, lamports: u64) -> Result<()> {
        require!(!ctx.accounts.court_acc.resolved, ErrorCode::AlreadyResolved);
        require!(lamports > 0, ErrorCode::ZeroStake);
        let b = &mut ctx.accounts.bet;
        require!(b.amount == 0 || b.yes == yes, ErrorCode::SideMismatch);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        b.market = ctx.accounts.market.key();
        b.bettor = ctx.accounts.bettor.key();
        b.yes = yes;
        b.amount = b.amount.checked_add(lamports).ok_or(ErrorCode::Overflow)?;
        b.bump = ctx.bumps.bet;
        let m = &mut ctx.accounts.market;
        if yes {
            m.yes_pool = m.yes_pool.checked_add(lamports).ok_or(ErrorCode::Overflow)?;
        } else {
            m.no_pool = m.no_pool.checked_add(lamports).ok_or(ErrorCode::Overflow)?;
        }
        emit!(BetEvent { market: m.key(), bettor: b.bettor, yes, lamports });
        Ok(())
    }

    /// Pays a bettor after the verdict: winners split the whole pool pro rata;
    /// a tie, an empty winning side or an incomplete verdict refunds every stake.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let court = &ctx.accounts.court_acc;
        require!(court.resolved, ErrorCode::NotResolved);
        let b = &mut ctx.accounts.bet;
        require!(!b.claimed, ErrorCode::AlreadyClaimed);
        let m = &ctx.accounts.market;
        let total = m.yes_pool as u128 + m.no_pool as u128;
        let winners_yes = court.yes > court.no;
        let winning_pool = if winners_yes { m.yes_pool } else { m.no_pool } as u128;
        let refund = court.incomplete || court.yes == court.no || winning_pool == 0;
        let payout: u64 = if refund {
            b.amount
        } else if b.yes == winners_yes {
            (b.amount as u128 * total / winning_pool) as u64
        } else {
            0
        };
        b.claimed = true;
        if payout > 0 {
            let market_key = m.key();
            let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[m.vault_bump]];
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.bettor.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
            )?;
        }
        emit!(ClaimEvent { market: m.key(), bettor: b.bettor, payout });
        Ok(())
    }
}

/// Takes the one-computation-at-a-time lock (see crate docs).
fn lock(court: &mut CourtAccount) -> Result<()> {
    require!(!court.resolved, ErrorCode::AlreadyResolved);
    require!(!court.pending, ErrorCode::ComputationPending);
    court.pending = true;
    Ok(())
}

const MAX_MARKET_LEN: usize = 64;

// ---------- queue accounts ----------

#[queue_computation_accounts("init_court_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, id: u32)]
pub struct CreateCourt<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_COURT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = 8 + CourtAccount::INIT_SPACE,
        seeds = [b"court", payer.key().as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("add_juror_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u32)]
pub struct AddJuror<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_JUROR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"court", payer.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("record_positions_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u32)]
pub struct RecordPositions<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_POSITIONS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    /// CHECK: court authority, only used to derive the court PDA
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"court", authority.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
        has_one = authority,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("cast_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u32)]
pub struct Cast<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CAST))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    /// CHECK: court authority, only used to derive the court PDA
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"court", authority.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
        has_one = authority,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("resolve_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u32)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RESOLVE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"court", payer.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

// ---------- callback accounts ----------

#[callback_accounts("init_court_v3")]
#[derive(Accounts)]
pub struct InitCourtV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_COURT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[callback_accounts("add_juror_v3")]
#[derive(Accounts)]
pub struct AddJurorV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_JUROR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[callback_accounts("record_positions_v3")]
#[derive(Accounts)]
pub struct RecordPositionsV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_POSITIONS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[callback_accounts("cast_v3")]
#[derive(Accounts)]
pub struct CastV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CAST))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[callback_accounts("resolve_v3")]
#[derive(Accounts)]
pub struct ResolveV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RESOLVE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

// ---------- comp def accounts ----------

#[init_computation_definition_accounts("init_court_v3", payer)]
#[derive(Accounts)]
pub struct InitInitCourtCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("add_juror_v3", payer)]
#[derive(Accounts)]
pub struct InitAddJurorCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("record_positions_v3", payer)]
#[derive(Accounts)]
pub struct InitRecordPositionsCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("cast_v3", payer)]
#[derive(Accounts)]
pub struct InitCastCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("resolve_v3", payer)]
#[derive(Accounts)]
pub struct InitResolveCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ---------- lock reset + market accounts ----------

#[derive(Accounts)]
#[instruction(_id: u32)]
pub struct ResetPending<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"court", payer.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub court_acc: Box<Account<'info, CourtAccount>>,
    #[account(
        init,
        payer = payer,
        space = 8 + MarketAccount::INIT_SPACE,
        seeds = [b"market", court_acc.key().as_ref()],
        bump,
    )]
    pub market: Account<'info, MarketAccount>,
    /// CHECK: lamport-only vault PDA owned by the system program; signs payouts via seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub court_acc: Box<Account<'info, CourtAccount>>,
    #[account(mut, has_one = court_acc @ ErrorCode::WrongCourt, seeds = [b"market", court_acc.key().as_ref()], bump = market.bump)]
    pub market: Account<'info, MarketAccount>,
    /// CHECK: lamport-only vault PDA, address pinned by seeds.
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + BetAccount::INIT_SPACE,
        seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub bet: Account<'info, BetAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub court_acc: Box<Account<'info, CourtAccount>>,
    #[account(has_one = court_acc @ ErrorCode::WrongCourt, seeds = [b"market", court_acc.key().as_ref()], bump = market.bump)]
    pub market: Account<'info, MarketAccount>,
    /// CHECK: lamport-only vault PDA, address pinned by seeds.
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = bettor, seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref()], bump = bet.bump)]
    pub bet: Account<'info, BetAccount>,
    pub system_program: Program<'info, System>,
}

// ---------- state ----------

#[account]
#[derive(InitSpace)]
pub struct CourtAccount {
    pub bump: u8,
    /// Encrypted court state; must stay right after `bump` (offset 9).
    pub state: [[u8; 32]; STATE_LEN],
    pub nonce: u128,
    pub id: u32,
    pub authority: Pubkey,
    #[max_len(64)]
    pub market: String,
    pub resolved: bool,
    pub yes: u8,
    pub no: u8,
    pub excluded: u8,
    /// A computation is queued and its callback has not landed yet.
    pub pending: bool,
    /// A slot overflowed, so the conflict check may be incomplete; markets refund.
    pub incomplete: bool,
}

#[account]
#[derive(InitSpace)]
pub struct MarketAccount {
    pub court_acc: Pubkey,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BetAccount {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub yes: bool,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Court already resolved")]
    AlreadyResolved,
    #[msg("Another computation is still pending for this court")]
    ComputationPending,
    #[msg("Market text is longer than 64 bytes")]
    MarketTooLong,
    #[msg("Court not resolved yet")]
    NotResolved,
    #[msg("Stake must be positive")]
    ZeroStake,
    #[msg("A bettor can only add to the side they already backed")]
    SideMismatch,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Market belongs to a different court")]
    WrongCourt,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[event]
pub struct BallotEvent {
    pub court: Pubkey,
}

#[event]
pub struct VerdictEvent {
    pub court: Pubkey,
    pub yes: u8,
    pub no: u8,
    pub excluded: u8,
    pub incomplete: bool,
}

#[event]
pub struct BetEvent {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub yes: bool,
    pub lamports: u64,
}

#[event]
pub struct ClaimEvent {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub payout: u64,
}
