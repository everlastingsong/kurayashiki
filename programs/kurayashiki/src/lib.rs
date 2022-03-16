use anchor_lang::prelude::*;
use anchor_spl::{
    token::{TokenAccount, Mint, Token},
    associated_token::AssociatedToken,
};
use solana_program::{
    pubkey,
    instruction::{Instruction, AccountMeta},
};
use pyth_client::{
    Price,
    PriceStatus,
    AccountType,
    VERSION_2,
    MAGIC,
    cast
};
use std::convert::TryFrom;
use borsh::{BorshDeserialize, BorshSerialize};
use spl_token;


declare_id!("F3jaebcEGakVPRagMXGZ13iPSnH5XUiwW35A5LCe1eVe");

// DEVNET におけるアカウント
const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC_MINT: Pubkey = pubkey!("FMwbjM1stnTzi74LV4cS937jeSUds7mZDgcdgnJ1yBDw"); // My USDC on Devnet
const ORCA_SWAP_PROGRAM_ID: Pubkey = pubkey!("3xQ8SWv2GaFXXpHZNqkXsdxq5DZciHBz6ZFoPPfbFd7U");
const ORCA_ADDRESS: Pubkey = pubkey!("3CbxF5jLJux7JwRceWkfLZZME8jFZWenvHwwo3ko2XKg");
const ORCA_AUTHORITY: Pubkey = pubkey!("22b7ZrVsaY7jrvYeGv5DqbZR5rqYTRFocc97TYAawhjp");
const ORCA_POOL_WSOL: Pubkey = pubkey!("6QRQnqSUDdgjWSpdXizK2hZ8HKfLiDogDaF1Edkq32Ev");
const ORCA_POOL_USDC: Pubkey = pubkey!("3mdEwkuwPEQyEG2qRH23khcb6xDvqfmbtQ4k5VPr27h6");
const ORCA_POOL_TOKEN_MINT: Pubkey = pubkey!("B3jS5cq1rVGXN4smYoAagq9UtYJcKxA6P5buaRBpsRXb");
const ORCA_FEE_ACCOUNT: Pubkey = pubkey!("2Fqu8eq8fFLjgyTB5cZAZt3bTMJw48oT2Np6dkJKhcB6");
const ORCA_SWAP_FEE: (u128, u128) = (30, 10000); // 0.3% (trade_fee: 0.25%, owner_fee: 0.05%)

const PYTH_SOL_USDC_PRICE: Pubkey = pubkey!("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

const DEPOSIT_SOL_MIN_BALANCE: u64 = 100_000_000; // 0.1 SOL (>= rent_exempt of system account * 2)
const POOL_DEPOSIT_SOL_MAX_BALANCE: u64 = 100_000_000; // 0.1 SOL

const MAX_ACCEPTABLE_DIFF_LAMPORTS: u64 = 50_000; // 0.000050 SOL (network fee of TX with 10 signers)
const MAX_ACCEPTABLE_UPDATE_INTERVAL: i64 = 60 * 60 * 72; // 72 hours
const GRACE_PERIOD: i64 = 60 * 10; // 10 minutes

#[derive(BorshSerialize, BorshDeserialize, Debug)]
struct OrcaSwapInstructionData {
    instruction: u8,
    pub input_amount: u64,
    pub minimum_output_amount: u64,
}


#[program]
pub mod kurayashiki {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>) -> ProgramResult {
        msg!("initialize called");

        msg!("transfer sol, creator to deposit_sol, {} lamports", DEPOSIT_SOL_MIN_BALANCE);
        let ix = solana_program::system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &ctx.accounts.deposit_sol.key(),
            DEPOSIT_SOL_MIN_BALANCE,
        );
        solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.deposit_sol.to_account_info(),
            ],
        )?;

        msg!("initialize price_info");
        ctx.accounts.price_info.current_usdc_per_sol_price = 0;
        ctx.accounts.price_info.current_usdc_per_sol_price_updated = 0;
        ctx.accounts.price_info.old_usdc_per_sol_price = 0;
        ctx.accounts.price_info.old_usdc_per_sol_price_grace_period = 0;

        Ok(())
    }

    pub fn update_price(ctx: Context<UpdatePrice>) -> ProgramResult {
        msg!("update_price called");

        // read from PYTH Price account
        let pyth_price_account_info = ctx.accounts.pyth_sol_usdc_price.to_account_info();
        let data = pyth_price_account_info.data.borrow();
        msg!("data len {}", (*data).len());
        let price = cast::<Price>( &data );
    
        assert_eq!( price.magic, MAGIC, "not a valid pyth account" );
        assert_eq!( price.atype, AccountType::Price as u32, "not a valid pyth price account" );
        assert_eq!( price.ver, VERSION_2, "unexpected pyth price account version" );
    
        let maybe_price = get_pyth_current_price(price);
        match maybe_price {
            Some((p, confidence, expo)) => {
                msg!("pyth price ........ {} x 10^{}", p, expo);
                msg!("pyth conf ......... {} x 10^{}", confidence, expo);

                let mut micro_usdc = p;
                let mut e = expo;
                while e < -6 { micro_usdc /= 10; e += 1; }
                while e > -6 { micro_usdc *= 10; e -= 1; }

                // 2倍のレートで提示する
                micro_usdc *= 2;

                let now = ctx.accounts.clock.unix_timestamp;
                let old = ctx.accounts.price_info.current_usdc_per_sol_price_updated;
                ctx.accounts.price_info.old_usdc_per_sol_price = ctx.accounts.price_info.current_usdc_per_sol_price;
                // 初期化直後や一定時間以上更新できていなかった場合は猶予期間は認めない
                ctx.accounts.price_info.old_usdc_per_sol_price_grace_period = if now - old <= MAX_ACCEPTABLE_UPDATE_INTERVAL { now + GRACE_PERIOD } else { 0 };
                ctx.accounts.price_info.current_usdc_per_sol_price = micro_usdc as u64;
                ctx.accounts.price_info.current_usdc_per_sol_price_updated = now;

                msg!("now: {}, old: {}", now, old);
                msg!("current_usdc_per_sol_price: {}", ctx.accounts.price_info.current_usdc_per_sol_price);
                msg!("current_usdc_per_sol_price_updated: {}", ctx.accounts.price_info.current_usdc_per_sol_price_updated);
                msg!("old_usdc_per_sol_price: {}", ctx.accounts.price_info.old_usdc_per_sol_price);
                msg!("old_usdc_per_sol_price_grace_period: {}", ctx.accounts.price_info.old_usdc_per_sol_price_grace_period);
            }
            None => {
                msg!("pyth price ........ unavailable");
                msg!("pyth conf ......... unavailable");
                return Err(ProgramError::InvalidAccountData);
            }
        }
        Ok(())
    }

    pub fn create_pool(ctx: Context<CreatePool>, index: u32) -> ProgramResult {
        msg!("create_pool called");

        msg!("transfer sol, creator to pool_deposit_sol, {} lamports", POOL_DEPOSIT_SOL_MAX_BALANCE);
        let ix = solana_program::system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &ctx.accounts.pool_deposit_sol.key(),
            POOL_DEPOSIT_SOL_MAX_BALANCE,
        );
        solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.pool_deposit_sol.to_account_info(),
            ],
        )?;

        Ok(())
    }

    pub fn neutralize(ctx: Context<Neutralize>, index: u32, price: u64, pre_tx_lamports: u64) -> ProgramResult {
        // トランザクション開始時点で fee は引かれている。（先払い)
        msg!("neutralize called");

        let current_lamports = ctx.accounts.user.lamports();
        msg!("pre_tx_lamports: {}, current_lamports: {}", pre_tx_lamports, current_lamports);

        // SOLが減少していなければなにもしない
        if current_lamports >= pre_tx_lamports { return Ok(()) }

        let diff_lamports = pre_tx_lamports - current_lamports;
        msg!("diff_lamports: {}", diff_lamports);

        if diff_lamports > MAX_ACCEPTABLE_DIFF_LAMPORTS {
            msg!("exeed MAX_ACCEPTABLE_DIFF_LAMPORTS");
            // ■■■■■不適切なエラー■■■■ カスタムエラーを定義すること
            return Err(ProgramError::InvalidArgument);
        }

        // 価格が妥当か
        let now = ctx.accounts.clock.unix_timestamp;
        if now <= ctx.accounts.price_info.current_usdc_per_sol_price_updated + MAX_ACCEPTABLE_UPDATE_INTERVAL
           && price == ctx.accounts.price_info.current_usdc_per_sol_price {
               // valid price
           }
        else if now <= ctx.accounts.price_info.old_usdc_per_sol_price_grace_period
           && price == ctx.accounts.price_info.old_usdc_per_sol_price {
               // valid price
        }
        else {
            // ■■■■■不適切なエラー■■■■ カスタムエラーを定義すること
            // 価格がおかしい
            msg!("invalid price");
            return Err(ProgramError::InvalidArgument);
        }

        // PDA
        let index_bytes = index.to_le_bytes();
        let init_seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda , bump) = Pubkey::find_program_address(&init_seeds, ctx.program_id);
        let seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump]];
        msg!("_pda: {}, bump: {}", _pda.to_string(), bump);

        // 回収するUSDCを算出
        let required_usdc: u64 = TryFrom::try_from(div_ceiling(
            (ctx.accounts.price_info.current_usdc_per_sol_price as u128) * (diff_lamports as u128),
            1_000_000_000 /* lamrports = 1 SOL */)).unwrap();

        // USDCを転送
        msg!("transfer usdc, user_usdc to pool_deposit_usdc, {} mUSDC", required_usdc);
        let transfer_usdc_ix = spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.user_usdc.key(),
            &ctx.accounts.pool_deposit_usdc.key(),
            &ctx.accounts.user.key(),
            &[],
            required_usdc
        )?;
        solana_program::program::invoke_signed(
            &transfer_usdc_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.user_usdc.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.pool_deposit_usdc.to_account_info(),
            ],
            &[],
        )?;

        // SOL転送
        msg!("transfer sol, pool_deposit_sol to user, {} lamports", diff_lamports);
        let ix = solana_program::system_instruction::transfer(
            &ctx.accounts.pool_deposit_sol.key(),
            &ctx.accounts.user.key(),
            diff_lamports,
        );
        solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.pool_deposit_sol.to_account_info(),
                ctx.accounts.user.to_account_info(),
            ],
            &[seeds.as_ref()],
        )?;

        Ok(())
    }

    pub fn collect_from_pool(ctx: Context<CollectFromPool>, index1: u32, index2: u32, index3: u32, index4: u32) -> ProgramResult {
        msg!("collect_from_pool called");

        // PDA
        let index_bytes1 = index1.to_le_bytes();
        let init_seeds1 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes1.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda1 , bump1) = Pubkey::find_program_address(&init_seeds1, ctx.program_id);
        let seeds1 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes1.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump1]];
        msg!("_pda1: {}, bump1: {}", _pda1.to_string(), bump1);

        let index_bytes2 = index2.to_le_bytes();
        let init_seeds2 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes2.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda2 , bump2) = Pubkey::find_program_address(&init_seeds2, ctx.program_id);
        let seeds2 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes2.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump2]];
        msg!("_pda2: {}, bump2: {}", _pda2.to_string(), bump2);

        let index_bytes3 = index3.to_le_bytes();
        let init_seeds3 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes3.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda3 , bump3) = Pubkey::find_program_address(&init_seeds3, ctx.program_id);
        let seeds3 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes3.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump3]];
        msg!("_pda3: {}, bump3: {}", _pda3.to_string(), bump3);

        let index_bytes4 = index4.to_le_bytes();
        let init_seeds4 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes4.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda4 , bump4) = Pubkey::find_program_address(&init_seeds4, ctx.program_id);
        let seeds4 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes4.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump4]];
        msg!("_pda4: {}, bump4: {}", _pda4.to_string(), bump4);

        // 4つのUSDCアカウントからUSDCを集める
        let pool_deposit_sols = [&ctx.accounts.pool_deposit_sol1, &ctx.accounts.pool_deposit_sol2, &ctx.accounts.pool_deposit_sol3, &ctx.accounts.pool_deposit_sol4];
        let pool_deposit_usdcs = [&ctx.accounts.pool_deposit_usdc1, &ctx.accounts.pool_deposit_usdc2, &ctx.accounts.pool_deposit_usdc3, &ctx.accounts.pool_deposit_usdc4];
        let seeds = [seeds1, seeds2, seeds3, seeds4];

        let mut usdc_amount_sum: u64 = 0;
        for i in 0..4 {
            let pool_deposit_sol = pool_deposit_sols[i];
            let pool_deposit_usdc = pool_deposit_usdcs[i];
            let seeds_for_pool_deposit_sol = seeds[i];
            let usdc_amount = pool_deposit_usdc.amount;
            usdc_amount_sum += usdc_amount;

            msg!("transfer usdc, pool_deposit_usdc to deposit_usdc, {} mUSDC", usdc_amount);
            let transfer_usdc_ix = spl_token::instruction::transfer(
                &ctx.accounts.token_program.key(),
                &pool_deposit_usdc.key(),
                &ctx.accounts.deposit_usdc.key(),
                &pool_deposit_sol.key(),
                &[],
                usdc_amount
            )?;
            solana_program::program::invoke_signed(
                &transfer_usdc_ix,
                &[
                    ctx.accounts.token_program.to_account_info(),
                    pool_deposit_usdc.to_account_info(),
                    ctx.accounts.deposit_usdc.to_account_info(),
                    pool_deposit_sol.to_account_info(),
                ],
                &[&seeds_for_pool_deposit_sol],
            )?;    
        }

        Ok(())
    }

    pub fn distribute_to_pool(ctx: Context<DistributeToPool>, index1: u32, index2: u32, index3: u32, index4: u32) -> ProgramResult {
        msg!("distribute_to_pool called");

        // PDA
        let init_seeds_sol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda_sol , bump_sol) = Pubkey::find_program_address(&init_seeds_sol, ctx.program_id);
        let seeds_sol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump_sol]];
        msg!("_pda_sol: {}, bump_sol: {}", _pda_sol.to_string(), bump_sol);

        let index_bytes1 = index1.to_le_bytes();
        let init_seeds1 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes1.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda1 , bump1) = Pubkey::find_program_address(&init_seeds1, ctx.program_id);
        let seeds1 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes1.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump1]];
        msg!("_pda1: {}, bump1: {}", _pda1.to_string(), bump1);

        let index_bytes2 = index2.to_le_bytes();
        let init_seeds2 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes2.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda2 , bump2) = Pubkey::find_program_address(&init_seeds2, ctx.program_id);
        let seeds2 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes2.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump2]];
        msg!("_pda2: {}, bump2: {}", _pda2.to_string(), bump2);

        let index_bytes3 = index3.to_le_bytes();
        let init_seeds3 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes3.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda3 , bump3) = Pubkey::find_program_address(&init_seeds3, ctx.program_id);
        let seeds3 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes3.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump3]];
        msg!("_pda3: {}, bump3: {}", _pda3.to_string(), bump3);

        let index_bytes4 = index4.to_le_bytes();
        let init_seeds4 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes4.as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda4 , bump4) = Pubkey::find_program_address(&init_seeds4, ctx.program_id);
        let seeds4 = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index_bytes4.as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump4]];
        msg!("_pda4: {}, bump4: {}", _pda4.to_string(), bump4);

        let pool_deposit_sols = [&ctx.accounts.pool_deposit_sol1, &ctx.accounts.pool_deposit_sol2, &ctx.accounts.pool_deposit_sol3, &ctx.accounts.pool_deposit_sol4];
        let seeds = [seeds1, seeds2, seeds3, seeds4];
        
        // SOL分配
        assert!(ctx.accounts.deposit_sol.lamports() >= DEPOSIT_SOL_MIN_BALANCE);
        let allocatable_lamports = ctx.accounts.deposit_sol.lamports() - DEPOSIT_SOL_MIN_BALANCE;
        msg!("allocatable_lamports: {}", allocatable_lamports);

        let mut sum_lamports = allocatable_lamports;
        for i in 0..4 {
            sum_lamports += pool_deposit_sols[i].lamports();
        }
        msg!("sum_lamports: {}", sum_lamports);

        // 上限は超えないように分配する
        let rebalanced_lamports = if sum_lamports / 4 >= POOL_DEPOSIT_SOL_MAX_BALANCE { POOL_DEPOSIT_SOL_MAX_BALANCE } else { sum_lamports / 4 };
        msg!("rebalanced_lamports: {}", rebalanced_lamports);

        // 起こってはならないが、POOL_DEPOSIT_SOL_MAX_BALANCE を供給できず、先に集めて平準化するしかない場合を考慮
        for i in 0..4 {
            let current_lamports = pool_deposit_sols[i].lamports();

            if current_lamports > rebalanced_lamports {
                msg!("transfer sol, pool_deposit_sol to deposit_sol, {} lamports", current_lamports - rebalanced_lamports);
                let ix = solana_program::system_instruction::transfer(
                    &pool_deposit_sols[i].key(),
                    &ctx.accounts.deposit_sol.key(),
                    current_lamports - rebalanced_lamports,
                );
                solana_program::program::invoke_signed(
                    &ix,
                    &[
                        ctx.accounts.system_program.to_account_info(),
                        pool_deposit_sols[i].to_account_info(),
                        ctx.accounts.deposit_sol.to_account_info(),
                    ],
                    &[seeds[i].as_ref()],
                )?;
            }
        }

        // 通常はこちらで POOL_DEPOSIT_SOL_MAX_BALANCE になるように配る
        for i in 0..4 {
            let current_lamports = pool_deposit_sols[i].lamports();

            if current_lamports < rebalanced_lamports {
                msg!("transfer sol, deposit_sol to pool_deposit_sol, {} lamports", rebalanced_lamports - current_lamports);
                let ix = solana_program::system_instruction::transfer(
                    &ctx.accounts.deposit_sol.key(),
                    &pool_deposit_sols[i].key(),
                    rebalanced_lamports - current_lamports,
                );
                solana_program::program::invoke_signed(
                    &ix,
                    &[
                        ctx.accounts.system_program.to_account_info(),
                        pool_deposit_sols[i].to_account_info(),
                        ctx.accounts.deposit_sol.to_account_info(),
                    ],
                    &[seeds_sol.as_ref()],
                )?;
            }
        }

        Ok(())
    }

    pub fn convert_to_sol(ctx: Context<ConvertToSol>) -> ProgramResult {
        msg!("convert_to_sol called");

        // PDA
        let init_seeds_sol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda_sol , bump_sol) = Pubkey::find_program_address(&init_seeds_sol, ctx.program_id);
        let seeds_sol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump_sol]];
        msg!("_pda_sol: {}, bump_sol: {}", _pda_sol.to_string(), bump_sol);

        let init_seeds_wsol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"temporary_deposit_wsol".as_ref(), &ctx.accounts.creator.key().to_bytes()];
        let (_pda_wsol , bump_wsol) = Pubkey::find_program_address(&init_seeds_wsol, ctx.program_id);
        let seeds_wsol = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"temporary_deposit_wsol".as_ref(), &ctx.accounts.creator.key().to_bytes(), &[bump_wsol]];
        msg!("_pda_wsol: {}, bump_wsol: {}", _pda_wsol.to_string(), bump_wsol);

        // WSOLアカウント一時作成
        msg!("create account");
        let create_wsol_account_ix = solana_program::system_instruction::create_account(
            &ctx.accounts.deposit_sol.key(),
            &ctx.accounts.temporary_deposit_wsol.key(),
            ctx.accounts.rent.minimum_balance(165),
            165,
            &ctx.accounts.token_program.key());
        solana_program::program::invoke_signed(
            &create_wsol_account_ix,
            &[
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.deposit_sol.to_account_info(),
                ctx.accounts.temporary_deposit_wsol.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds_sol.as_ref(), seeds_wsol.as_ref()],
        )?;
        msg!("initialize account");
        let init_account_ix = spl_token::instruction::initialize_account(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.temporary_deposit_wsol.key(),
            &ctx.accounts.wsol_mint.key(),
            &ctx.accounts.deposit_sol.key())?;
        solana_program::program::invoke(
            &init_account_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.temporary_deposit_wsol.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.deposit_sol.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
        )?;

        // ORCAスワップ実行
        let input_usdc = ctx.accounts.deposit_usdc.amount;
        let output_wsol = get_expected_output_amount(ctx.accounts.orca_pool_usdc.amount, ctx.accounts.orca_pool_wsol.amount, input_usdc);
        msg!("swap usdc to wsol, {} mUSDC to expected {} lamports", input_usdc, output_wsol);
        let swap_ix = Instruction {
            program_id: ctx.accounts.orca_swap_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.orca_address.key(), false),
                AccountMeta::new_readonly(ctx.accounts.orca_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.deposit_sol.key(), true),
                AccountMeta::new(ctx.accounts.deposit_usdc.key(), false),
                AccountMeta::new(ctx.accounts.orca_pool_usdc.key(), false),
                AccountMeta::new(ctx.accounts.orca_pool_wsol.key(), false),
                AccountMeta::new(ctx.accounts.temporary_deposit_wsol.key(), false),
                AccountMeta::new(ctx.accounts.orca_pool_token_mint.key(), false),
                AccountMeta::new(ctx.accounts.orca_fee_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            // https://docs.rs/borsh/latest/borsh/fn.to_vec.html
            data: OrcaSwapInstructionData {
                instruction: 1, // Swap instruction
                input_amount: input_usdc,
                minimum_output_amount: output_wsol,
            }.try_to_vec()?
        };
        solana_program::program::invoke_signed(
            &swap_ix,
            &[
                ctx.accounts.orca_swap_program.to_account_info(),
                ctx.accounts.orca_address.to_account_info(),
                ctx.accounts.orca_authority.to_account_info(),
                ctx.accounts.deposit_sol.to_account_info(),
                ctx.accounts.deposit_usdc.to_account_info(),
                ctx.accounts.orca_pool_usdc.to_account_info(),
                ctx.accounts.orca_pool_wsol.to_account_info(),
                ctx.accounts.temporary_deposit_wsol.to_account_info(),
                ctx.accounts.orca_pool_token_mint.to_account_info(),
                ctx.accounts.orca_fee_account.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds_sol.as_ref()],
        )?;

        // WSOLアカウントクローズ/SOL回収
        let close_account_ix = spl_token::instruction::close_account(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.temporary_deposit_wsol.key(),
            &ctx.accounts.deposit_sol.key(),
            &ctx.accounts.deposit_sol.key(),
            &[],
        )?;
        solana_program::program::invoke_signed(
            &close_account_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.temporary_deposit_wsol.to_account_info(),
                ctx.accounts.deposit_sol.to_account_info(),
            ],
            &[&seeds_sol]
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(init, payer = creator, space = 32 + 8, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"price_info".as_ref(), &creator.key().to_bytes()], bump)]
    pub price_info: Box<Account<'info, PriceInfo>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref()/*, &0u32.to_le_bytes()*/, &creator.key().to_bytes()], bump)]
    pub deposit_sol: SystemAccount<'info>,
    #[account(init, payer = creator, associated_token::mint = usdc_mint, associated_token::authority = deposit_sol)]
    pub deposit_usdc: Box<Account<'info, TokenAccount>>,
// aux accounts
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub creator: SystemAccount<'info>,

    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"price_info".as_ref(), &creator.key().to_bytes()], bump)]
    pub price_info: Box<Account<'info, PriceInfo>>,
    #[account(address = PYTH_SOL_USDC_PRICE)]
    pub pyth_sol_usdc_price: AccountInfo<'info>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol: SystemAccount<'info>,
    #[account(init, payer = creator, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol)]
    pub pool_deposit_usdc: Box<Account<'info, TokenAccount>>,
// aux accounts
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(index1: u32, index2: u32, index3: u32, index4: u32)]
pub struct CollectFromPool<'info> {
    pub creator: SystemAccount<'info>,

    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &creator.key().to_bytes()], bump)]
    pub deposit_sol: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = deposit_sol)]
    pub deposit_usdc: Box<Account<'info, TokenAccount>>,

    // pool accounts
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index1.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol1: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol1)]
    pub pool_deposit_usdc1: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index2.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol2: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol2)]
    pub pool_deposit_usdc2: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index3.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol3: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol3)]
    pub pool_deposit_usdc3: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index4.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol4: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol4)]
    pub pool_deposit_usdc4: Box<Account<'info, TokenAccount>>,

    // aux accounts
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(index1: u32, index2: u32, index3: u32, index4: u32)]
pub struct DistributeToPool<'info> {
    pub creator: SystemAccount<'info>,

    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &creator.key().to_bytes()], bump)]
    pub deposit_sol: SystemAccount<'info>,

    // pool accounts
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index1.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol1: SystemAccount<'info>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index2.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol2: SystemAccount<'info>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index3.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol3: SystemAccount<'info>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index4.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol4: SystemAccount<'info>,

    // aux accounts
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct ConvertToSol<'info> {
    pub creator: SystemAccount<'info>,

    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), &creator.key().to_bytes()], bump)]
    pub deposit_sol: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = deposit_sol)]
    pub deposit_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"temporary_deposit_wsol".as_ref(), &creator.key().to_bytes()], bump)]
    pub temporary_deposit_wsol: AccountInfo<'info>,

    // ORCA accounts
    #[account(address = ORCA_SWAP_PROGRAM_ID)]
    pub orca_swap_program: AccountInfo<'info>,
    #[account(address = ORCA_ADDRESS)]
    pub orca_address: AccountInfo<'info>,
    #[account(address = ORCA_AUTHORITY)]
    pub orca_authority: AccountInfo<'info>,
    #[account(mut, address = ORCA_POOL_WSOL)]
    pub orca_pool_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = ORCA_POOL_USDC)]
    pub orca_pool_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = ORCA_POOL_TOKEN_MINT)]
    pub orca_pool_token_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = ORCA_FEE_ACCOUNT)]
    pub orca_fee_account: Box<Account<'info, TokenAccount>>,

    // aux accounts
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct Neutralize<'info> {
    pub creator: SystemAccount<'info>,
    #[account(seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"price_info".as_ref(), &creator.key().to_bytes()], bump)]
    pub price_info: Box<Account<'info, PriceInfo>>,
    #[account(mut, seeds = [b"kurayashiki".as_ref(), b"nano_swap".as_ref(), b"deposit_sol".as_ref(), index.to_le_bytes().as_ref(), &creator.key().to_bytes()], bump)]
    pub pool_deposit_sol: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = pool_deposit_sol)]
    pub pool_deposit_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    // aux accounts
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
}

#[account]
pub struct PriceInfo {
    pub current_usdc_per_sol_price: u64,
    pub current_usdc_per_sol_price_updated: i64,   // UnixTimestamp
    pub old_usdc_per_sol_price: u64,
    pub old_usdc_per_sol_price_grace_period: i64,  // UnixTimestamp
}

fn get_pyth_current_price( price: &Price ) -> Option<(i64, u64, i32)> {
    if !matches!(price.agg.status, PriceStatus::Trading) {
        None
    } else {
        Some((price.agg.price, price.agg.conf, price.expo))
    }
}

fn div_ceiling(numerator: u128, denominator: u128) -> u128 {
    if numerator % denominator == 0 { numerator / denominator } else { numerator / denominator + 1 }
}

fn get_expected_output_amount(
    input_pool_balance: u64,
    output_pool_balance: u64,
    input_amount: u64,
) -> u64 {
    let ib: u128 = From::from(input_pool_balance);
    let ob: u128 = From::from(output_pool_balance);
    let ia: u128 = From::from(input_amount);

    let orca_fee = ORCA_SWAP_FEE;

    let of = div_ceiling(ia * orca_fee.0, orca_fee.1);
    let mia = ia - of;

    let invariant = ib * ob;
    let next_ib = ib + mia;
    let next_ob = div_ceiling(invariant, next_ib);

    let expected_oa = ob - next_ob;

    let expected_oa_u64: u64 = TryFrom::try_from(expected_oa).unwrap();
    expected_oa_u64
}