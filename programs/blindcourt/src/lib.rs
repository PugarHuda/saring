//! Blindcourt: a conflict-blind jury for prediction-market disputes.
//!
//! Each `CourtAccount` keeps one MXE-encrypted state (see encrypted-ixs): who holds
//! a position in the disputed market, who sits on the jury, and each juror's latest
//! ballot. Every update happens inside MPC. `resolve` ignores jurors who hold a
//! position and reveals only (yes, no, excluded) — never which jurors were dropped.
//!
//! Layout read by circuits via `ArgBuilder::account`: 8-byte discriminator, 1-byte
//! `bump`, then `state` (STATE_LEN x 32-byte ciphertexts) at offset 9.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;

/// Public host for the compiled `.arcis` circuits (GitHub release assets).
const CIRCUIT_BASE_URL: &str = "https://github.com/PugarHuda/blindcourt/releases/download/circuits-v1/";

fn offchain(name: &str, hash: [u8; 32]) -> CircuitSource {
    CircuitSource::OffChain(OffChainCircuitSource {
        source: format!("{CIRCUIT_BASE_URL}{name}.arcis"),
        hash,
    })
}

const COMP_DEF_OFFSET_INIT_COURT: u32 = comp_def_offset("init_court");
const COMP_DEF_OFFSET_ADD_JUROR: u32 = comp_def_offset("add_juror");
const COMP_DEF_OFFSET_RECORD_POSITION: u32 = comp_def_offset("record_position");
const COMP_DEF_OFFSET_CAST: u32 = comp_def_offset("cast");
const COMP_DEF_OFFSET_RESOLVE: u32 = comp_def_offset("resolve");

/// Ciphertexts produced by `Pack<[u32; 32]>`.
pub const STATE_LEN: usize = 6;
const STATE_OFFSET: u32 = 8 + 1;
const STATE_BYTES: u32 = 32 * STATE_LEN as u32;

declare_id!("3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy");

#[arcium_program]
pub mod blindcourt {
    use super::*;

    // Circuits (~450 KB each) are fetched by Arx nodes from the GitHub release and
    // checked against the hash compiled in here.
    pub fn init_init_court_comp_def(ctx: Context<InitInitCourtCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("init_court", circuit_hash!("init_court"))))?;
        Ok(())
    }
    pub fn init_add_juror_comp_def(ctx: Context<InitAddJurorCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("add_juror", circuit_hash!("add_juror"))))?;
        Ok(())
    }
    pub fn init_record_position_comp_def(ctx: Context<InitRecordPositionCompDef>) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            Some(offchain("record_position", circuit_hash!("record_position"))),
        )?;
        Ok(())
    }
    pub fn init_cast_comp_def(ctx: Context<InitCastCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("cast", circuit_hash!("cast"))))?;
        Ok(())
    }
    pub fn init_resolve_comp_def(ctx: Context<InitResolveCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, Some(offchain("resolve", circuit_hash!("resolve"))))?;
        Ok(())
    }

    /// Opens a dispute court for one market and queues `init_court` (empty state).
    pub fn create_court(
        ctx: Context<CreateCourt>,
        computation_offset: u64,
        id: u32,
        market: String,
    ) -> Result<()> {
        let court = &mut ctx.accounts.court_acc;
        court.bump = ctx.bumps.court_acc;
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
            vec![InitCourtCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "init_court")]
    pub fn init_court_callback(
        ctx: Context<InitCourtCallback>,
        output: SignedComputationOutputs<InitCourtOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(InitCourtOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        Ok(())
    }

    /// Seats an encrypted juror id. Authority only (stands in for sortition + SAS).
    pub fn add_juror(
        ctx: Context<AddJuror>,
        computation_offset: u64,
        _id: u32,
        juror_id: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(!ctx.accounts.court_acc.resolved, ErrorCode::AlreadyResolved);
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u32(juror_id)
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AddJurorCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "add_juror")]
    pub fn add_juror_callback(
        ctx: Context<AddJurorCallback>,
        output: SignedComputationOutputs<AddJurorOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(AddJurorOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        Ok(())
    }

    /// Records an encrypted trader id as holding a position in this market.
    // ponytail: open to any signer for the demo; in production the market program CPIs this on every fill.
    pub fn record_position(
        ctx: Context<RecordPosition>,
        computation_offset: u64,
        _id: u32,
        trader_id: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(!ctx.accounts.court_acc.resolved, ErrorCode::AlreadyResolved);
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u32(trader_id)
            .plaintext_u128(ctx.accounts.court_acc.nonce)
            .account(ctx.accounts.court_acc.key(), STATE_OFFSET, STATE_BYTES)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let key = ctx.accounts.court_acc.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RecordPositionCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "record_position")]
    pub fn record_position_callback(
        ctx: Context<RecordPositionCallback>,
        output: SignedComputationOutputs<RecordPositionOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(RecordPositionOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        Ok(())
    }

    /// Casts or overwrites an encrypted ballot. Any payer can submit it (relayable),
    /// so the signer reveals nothing about who the juror is.
    pub fn cast(
        ctx: Context<Cast>,
        computation_offset: u64,
        _id: u32,
        juror_id: [u8; 32],
        yes: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(!ctx.accounts.court_acc.resolved, ErrorCode::AlreadyResolved);
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u32(juror_id)
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
            vec![CastCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "cast")]
    pub fn cast_callback(
        ctx: Context<CastCallback>,
        output: SignedComputationOutputs<CastOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(CastOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        ctx.accounts.court_acc.state = o.ciphertexts;
        ctx.accounts.court_acc.nonce = o.nonce;
        emit!(BallotEvent { court: ctx.accounts.court_acc.key() });
        Ok(())
    }

    /// Tallies conflict-free ballots. Authority only.
    pub fn resolve(ctx: Context<Resolve>, computation_offset: u64, _id: u32) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.court_acc.authority,
            ErrorCode::InvalidAuthority
        );
        require!(!ctx.accounts.court_acc.resolved, ErrorCode::AlreadyResolved);
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
            vec![ResolveCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "resolve")]
    pub fn resolve_callback(
        ctx: Context<ResolveCallback>,
        output: SignedComputationOutputs<ResolveOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ResolveOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let court = &mut ctx.accounts.court_acc;
        court.resolved = true;
        court.yes = o.field_0;
        court.no = o.field_1;
        court.excluded = o.field_2;
        emit!(VerdictEvent {
            court: court.key(),
            yes: court.yes,
            no: court.no,
            excluded: court.excluded,
        });
        Ok(())
    }
}

// ---------- queue accounts ----------

#[queue_computation_accounts("init_court", payer)]
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

#[queue_computation_accounts("add_juror", payer)]
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
        seeds = [b"court", payer.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("record_position", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u32)]
pub struct RecordPosition<'info> {
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_POSITION))]
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
        seeds = [b"court", authority.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
        has_one = authority,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("cast", payer)]
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
        seeds = [b"court", authority.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
        has_one = authority,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

#[queue_computation_accounts("resolve", payer)]
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
        seeds = [b"court", payer.key().as_ref(), _id.to_le_bytes().as_ref()],
        bump = court_acc.bump,
    )]
    pub court_acc: Box<Account<'info, CourtAccount>>,
}

// ---------- callback accounts ----------

#[callback_accounts("init_court")]
#[derive(Accounts)]
pub struct InitCourtCallback<'info> {
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

#[callback_accounts("add_juror")]
#[derive(Accounts)]
pub struct AddJurorCallback<'info> {
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

#[callback_accounts("record_position")]
#[derive(Accounts)]
pub struct RecordPositionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_POSITION))]
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

#[callback_accounts("cast")]
#[derive(Accounts)]
pub struct CastCallback<'info> {
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

#[callback_accounts("resolve")]
#[derive(Accounts)]
pub struct ResolveCallback<'info> {
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

#[init_computation_definition_accounts("init_court", payer)]
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

#[init_computation_definition_accounts("add_juror", payer)]
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

#[init_computation_definition_accounts("record_position", payer)]
#[derive(Accounts)]
pub struct InitRecordPositionCompDef<'info> {
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

#[init_computation_definition_accounts("cast", payer)]
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

#[init_computation_definition_accounts("resolve", payer)]
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
}
