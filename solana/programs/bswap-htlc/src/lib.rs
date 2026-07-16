//! BrowserSwaps HTLC for Solana — hashed-timelock escrow for SPL tokens
//! (USDC / USDT), the Solana twin of contracts/HTLC.sol v3.
//!
//! Relaying is native here: users without SOL partially sign the very same
//! `lock` / `claim` / `refund` transaction and a relayer countersigns as fee
//! payer. There is therefore NO permit / LockIntent / WithdrawIntent
//! machinery — the sender's ed25519 signature on the transaction already
//! binds every parameter, and the recent-blockhash rule makes replay
//! impossible. Plain withdrawals need no program at all (a co-signed
//! SPL transfer does it), so this program only escrows swaps.
//!
//! Fee model mirrors the EVM contract:
//!   - `lock_fee`  — paid by the sender to the relayer that submits the lock.
//!   - `relay_fee` — stored in the lock; paid to a non-beneficiary submitter
//!     of claim/refund, out of the escrowed amount. Self-submit = no fee.
//!
//! Lock identity mirrors the EVM contract too: the state PDA is seeded by
//! sha256(sender ‖ recipient ‖ mint ‖ amount_le ‖ hashlock ‖ timelock_le) —
//! the same six fields HTLC.sol hashes into its lock id — so a duplicate
//! lock fails at PDA init and both sides can derive the id offline.
//!
//! Rent: the fee payer fronts rent for the two accounts (~0.003 SOL). The
//! vault's rent returns on claim/refund; the state account stays behind as a
//! claimed/refunded tombstone (holding the revealed secret) until anyone
//! calls `reap` after the timelock, which returns the rest to the payer.
//!
//! No owner, no admin, no upgrade authority once deployed frozen.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("BgonehyDwfg8UtUKQW5TkYLAvFnJ47BRXu1TLYaDZ1dV");

pub const LOCK_SEED: &[u8] = b"lock";
pub const VAULT_SEED: &[u8] = b"vault";

/// sha256 over the six identity fields, exactly like HTLC.sol's
/// keccak256(abi.encode(sender, recipient, token, amount, hashlock, timelock)).
pub fn lock_id_for(
    sender: &Pubkey,
    recipient: &Pubkey,
    mint: &Pubkey,
    amount: u64,
    hashlock: &[u8; 32],
    timelock: i64,
) -> [u8; 32] {
    hashv(&[
        sender.as_ref(),
        recipient.as_ref(),
        mint.as_ref(),
        &amount.to_le_bytes(),
        hashlock,
        &timelock.to_le_bytes(),
    ])
    .to_bytes()
}

#[program]
pub mod bswap_htlc {
    use super::*;

    /// Escrow `amount` of `mint` for `recipient` behind sha256 `hashlock`
    /// until `timelock`. The sender signs; the (possibly different) fee payer
    /// fronts rent and receives `lock_fee` in tokens when it is a third party.
    #[allow(clippy::too_many_arguments)]
    pub fn lock(
        ctx: Context<LockAccounts>,
        lock_id: [u8; 32],
        recipient: Pubkey,
        amount: u64,
        hashlock: [u8; 32],
        timelock: i64,
        relay_fee: u64,
        lock_fee: u64,
    ) -> Result<()> {
        require!(amount > 0, HtlcError::ZeroAmount);
        require!(recipient != Pubkey::default(), HtlcError::ZeroRecipient);
        require!(relay_fee < amount, HtlcError::RelayFeeTooBig);
        let now = Clock::get()?.unix_timestamp;
        require!(timelock > now, HtlcError::TimelockInPast);

        // The client derives the PDA from lock_id, so lock_id MUST be the
        // canonical hash of the parameters or the whole lock is malformed.
        let expect = lock_id_for(
            ctx.accounts.sender.key,
            &recipient,
            &ctx.accounts.mint.key(),
            amount,
            &hashlock,
            timelock,
        );
        require!(lock_id == expect, HtlcError::BadLockId);

        // Escrow the principal.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
        )?;

        // Compensate a third-party relayer for gas + rent, in tokens.
        if lock_fee > 0 && ctx.accounts.payer.key() != ctx.accounts.sender.key() {
            let payer_token = ctx
                .accounts
                .payer_token
                .as_ref()
                .ok_or(HtlcError::MissingFeeAccount)?;
            require!(
                payer_token.owner == ctx.accounts.payer.key(),
                HtlcError::FeeAccountOwner
            );
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sender_token.to_account_info(),
                        to: payer_token.to_account_info(),
                        authority: ctx.accounts.sender.to_account_info(),
                    },
                ),
                lock_fee,
            )?;
        }

        let s = &mut ctx.accounts.lock_state;
        s.lock_id = lock_id;
        s.bump = ctx.bumps.lock_state;
        s.vault_bump = ctx.bumps.vault;
        s.mint = ctx.accounts.mint.key();
        s.sender = ctx.accounts.sender.key();
        s.recipient = recipient;
        s.rent_payer = ctx.accounts.payer.key();
        s.amount = amount;
        s.hashlock = hashlock;
        s.timelock = timelock;
        s.relay_fee = relay_fee;
        s.status = LockStatus::Open;
        s.secret = [0u8; 32];

        emit!(Locked {
            lock_id,
            sender: s.sender,
            recipient,
            mint: s.mint,
            amount,
            hashlock,
            timelock,
        });
        Ok(())
    }

    /// Reveal the secret, release tokens to the fixed recipient. Callable by
    /// anyone at any time while open (like the EVM claim, there is no upper
    /// time bound — only a later refund closes the window). A non-recipient
    /// submitter earns `relay_fee` out of the escrow.
    pub fn claim(ctx: Context<ClaimAccounts>, secret: [u8; 32]) -> Result<()> {
        let s = &ctx.accounts.lock_state;
        require!(s.status == LockStatus::Open, HtlcError::AlreadyClosed);
        require!(
            hashv(&[&secret]).to_bytes() == s.hashlock,
            HtlcError::BadSecret
        );

        let fee = if ctx.accounts.submitter.key() != s.recipient {
            s.relay_fee
        } else {
            0
        };
        pay_out(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.lock_state,
            &ctx.accounts.beneficiary_token,
            ctx.accounts.submitter_token.as_ref(),
            &ctx.accounts.rent_payer,
            s.amount,
            fee,
        )?;

        let s = &mut ctx.accounts.lock_state;
        s.status = LockStatus::Claimed;
        s.secret = secret;
        emit!(Claimed { lock_id: s.lock_id, secret });
        Ok(())
    }

    /// Return the escrow to the sender at/after the timelock. Relayable on
    /// the same terms as claim.
    pub fn refund(ctx: Context<RefundAccounts>) -> Result<()> {
        let s = &ctx.accounts.lock_state;
        require!(s.status == LockStatus::Open, HtlcError::AlreadyClosed);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= s.timelock, HtlcError::TimelockNotReached);

        let fee = if ctx.accounts.submitter.key() != s.sender {
            s.relay_fee
        } else {
            0
        };
        pay_out(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.lock_state,
            &ctx.accounts.beneficiary_token,
            ctx.accounts.submitter_token.as_ref(),
            &ctx.accounts.rent_payer,
            s.amount,
            fee,
        )?;

        let s = &mut ctx.accounts.lock_state;
        s.status = LockStatus::Refunded;
        emit!(Refunded { lock_id: s.lock_id });
        Ok(())
    }

    /// Close a settled lock's state account and return its rent to whoever
    /// fronted it. Permissionless, but only after the timelock, so watchers
    /// have the whole swap window to read the outcome (and revealed secret).
    pub fn reap(ctx: Context<ReapAccounts>) -> Result<()> {
        let s = &ctx.accounts.lock_state;
        require!(s.status != LockStatus::Open, HtlcError::StillOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= s.timelock, HtlcError::TimelockNotReached);
        Ok(())
    }
}

/// Move `amount` out of the vault — `fee` to the submitter (when relayed),
/// the rest to the beneficiary — then close the emptied vault to the rent
/// payer. The vault's authority is the lock-state PDA, so every transfer is
/// signed with its seeds.
#[allow(clippy::too_many_arguments)]
fn pay_out<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    lock_state: &Account<'info, LockState>,
    beneficiary_token: &Account<'info, TokenAccount>,
    submitter_token: Option<&Account<'info, TokenAccount>>,
    rent_payer: &UncheckedAccount<'info>,
    amount: u64,
    fee: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[LOCK_SEED, lock_state.lock_id.as_ref(), &[lock_state.bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    if fee > 0 {
        let fee_to = submitter_token.ok_or(HtlcError::MissingFeeAccount)?;
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: fee_to.to_account_info(),
                    authority: lock_state.to_account_info(),
                },
                signer,
            ),
            fee,
        )?;
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: beneficiary_token.to_account_info(),
                authority: lock_state.to_account_info(),
            },
            signer,
        ),
        amount - fee,
    )?;
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_payer.to_account_info(),
            authority: lock_state.to_account_info(),
        },
        signer,
    ))
}

// ---------------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LockStatus {
    Open,
    Claimed,
    Refunded,
}

#[account]
pub struct LockState {
    pub lock_id: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
    pub mint: Pubkey,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub rent_payer: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
    pub relay_fee: u64,
    pub status: LockStatus,
    /// The revealed preimage once claimed (zero before) — lets late watchers
    /// read the secret straight from account state instead of tx history.
    pub secret: [u8; 32],
}

impl LockState {
    pub const SIZE: usize = 32 + 1 + 1 + 32 + 32 + 32 + 32 + 8 + 32 + 8 + 8 + 1 + 32;
}

// ------------------------------------------------------------------- accounts

#[derive(Accounts)]
#[instruction(lock_id: [u8; 32])]
pub struct LockAccounts<'info> {
    /// The token payer. Must sign even when relayed — the signature is what
    /// authorizes the escrow (Solana's replacement for permit + LockIntent).
    pub sender: Signer<'info>,
    /// Transaction fee payer, fronts rent. The sender itself on self-submit.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = sender)]
    pub sender_token: Account<'info, TokenAccount>,
    /// Relayer's token account for `lock_fee`; only needed on relayed locks.
    #[account(mut, token::mint = mint)]
    pub payer_token: Option<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        space = 8 + LockState::SIZE,
        seeds = [LOCK_SEED, lock_id.as_ref()],
        bump,
    )]
    pub lock_state: Account<'info, LockState>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, lock_id.as_ref()],
        bump,
        token::mint = mint,
        token::authority = lock_state,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimAccounts<'info> {
    /// Whoever submits (relayer or the recipient). Pays the beneficiary-ATA
    /// rent if it doesn't exist yet; earns `relay_fee` when not the recipient.
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(
        mut,
        seeds = [LOCK_SEED, lock_state.lock_id.as_ref()],
        bump = lock_state.bump,
        has_one = mint,
        has_one = recipient,
        has_one = rent_payer,
    )]
    pub lock_state: Account<'info, LockState>,
    #[account(
        mut,
        seeds = [VAULT_SEED, lock_state.lock_id.as_ref()],
        bump = lock_state.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: pubkey pinned by has_one against the lock record; only used as
    /// the ATA authority below.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = submitter,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    /// Submitter's fee account; required only when a relay fee is due.
    #[account(mut, token::mint = mint, token::authority = submitter)]
    pub submitter_token: Option<Account<'info, TokenAccount>>,
    /// CHECK: pubkey pinned by has_one; receives the closed vault's rent.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundAccounts<'info> {
    /// Whoever submits (relayer or the sender itself).
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(
        mut,
        seeds = [LOCK_SEED, lock_state.lock_id.as_ref()],
        bump = lock_state.bump,
        has_one = mint,
        has_one = sender,
        has_one = rent_payer,
    )]
    pub lock_state: Account<'info, LockState>,
    #[account(
        mut,
        seeds = [VAULT_SEED, lock_state.lock_id.as_ref()],
        bump = lock_state.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: pubkey pinned by has_one against the lock record; only used as
    /// the ATA authority below.
    pub sender: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = submitter,
        associated_token::mint = mint,
        associated_token::authority = sender,
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    /// Submitter's fee account; required only when a relay fee is due.
    #[account(mut, token::mint = mint, token::authority = submitter)]
    pub submitter_token: Option<Account<'info, TokenAccount>>,
    /// CHECK: pubkey pinned by has_one; receives the closed vault's rent.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReapAccounts<'info> {
    #[account(
        mut,
        close = rent_payer,
        seeds = [LOCK_SEED, lock_state.lock_id.as_ref()],
        bump = lock_state.bump,
        has_one = rent_payer,
    )]
    pub lock_state: Account<'info, LockState>,
    /// CHECK: pubkey pinned by has_one; receives the closed account's rent.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct Locked {
    pub lock_id: [u8; 32],
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
}

#[event]
pub struct Claimed {
    pub lock_id: [u8; 32],
    pub secret: [u8; 32],
}

#[event]
pub struct Refunded {
    pub lock_id: [u8; 32],
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum HtlcError {
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("recipient must not be the zero address")]
    ZeroRecipient,
    #[msg("relay fee must be smaller than the amount")]
    RelayFeeTooBig,
    #[msg("timelock must be in the future")]
    TimelockInPast,
    #[msg("lock id does not hash the given parameters")]
    BadLockId,
    #[msg("lock already claimed or refunded")]
    AlreadyClosed,
    #[msg("sha256(secret) does not match the hashlock")]
    BadSecret,
    #[msg("timelock not reached")]
    TimelockNotReached,
    #[msg("fee token account required but not supplied")]
    MissingFeeAccount,
    #[msg("fee token account is not owned by the fee earner")]
    FeeAccountOwner,
    #[msg("lock is still open")]
    StillOpen,
}
