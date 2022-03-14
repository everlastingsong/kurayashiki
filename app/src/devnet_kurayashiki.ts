import * as idl from '../../target/idl/kurayashiki.json';
import type { Kurayashiki } from '../../target/types/kurayashiki';

import { Keypair, Connection, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { Idl, Program, Provider, BN as AnchorBN } from '@project-serum/anchor';
import { ORCA_TOKEN_SWAP_ID, ORCA_TOKEN_SWAP_ID_DEVNET, Network } from '@orca-so/sdk';
import { OrcaPoolParams, CurveType } from '@orca-so/sdk/dist/model/orca/pool/pool-types';
import { Percentage } from '@orca-so/sdk/dist/public/utils/models/percentage';
import { OrcaPoolImpl } from '@orca-so/sdk/dist/model/orca/pool/orca-pool'
import * as Tokens from '@orca-so/sdk/dist/constants/tokens';

import Decimal from 'decimal.js';


const BN = (n:number) => { return new AnchorBN(n); } 

const RPC_ENDPOINT_URL = "https://api.devnet.solana.com";
const KURAYASHIKI_PROGRAM_ID = new PublicKey("F3jaebcEGakVPRagMXGZ13iPSnH5XUiwW35A5LCe1eVe");


// 好きなウォレットを作るために必要 (anchorの用意するものはsignerにできない)
class Wallet {
    constructor(readonly payer: Keypair) {}
  
    async signTransaction(tx: Transaction): Promise<Transaction> {
        tx.partialSign(this.payer);
        return tx;
    }
  
    async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
        return txs.map((t) => {
            t.partialSign(this.payer);
            return t;
        });
    }
  
    get publicKey(): PublicKey {
        return this.payer.publicKey;
    }
}

const commitment = 'confirmed';
const connection = new Connection(RPC_ENDPOINT_URL, commitment);
const secret = Uint8Array.from(JSON.parse(require("fs").readFileSync("/Users/ikeyanagi/.config/solana/id1.json")));
const wallet = Keypair.fromSecretKey(secret as Uint8Array);
const secret2 = Uint8Array.from(JSON.parse(require("fs").readFileSync("/Users/ikeyanagi/.config/solana/id2.json")));
const wallet2 = Keypair.fromSecretKey(secret2 as Uint8Array);

const provider = new Provider(connection, new Wallet(wallet), { preflightCommitment: commitment });
const program = new Program(idl as Idl, KURAYASHIKI_PROGRAM_ID, provider) as Program<Kurayashiki>;

const orca_address = new PublicKey("3CbxF5jLJux7JwRceWkfLZZME8jFZWenvHwwo3ko2XKg");
const orca_authority = new PublicKey("22b7ZrVsaY7jrvYeGv5DqbZR5rqYTRFocc97TYAawhjp");
const orca_pool_token_mint = new PublicKey("B3jS5cq1rVGXN4smYoAagq9UtYJcKxA6P5buaRBpsRXb");
const orca_fee_account = new PublicKey("2Fqu8eq8fFLjgyTB5cZAZt3bTMJw48oT2Np6dkJKhcB6");
const orca_token_A_deposit = new PublicKey("6QRQnqSUDdgjWSpdXizK2hZ8HKfLiDogDaF1Edkq32Ev"); /* WSOL deposit */
const orca_token_B_deposit = new PublicKey("3mdEwkuwPEQyEG2qRH23khcb6xDvqfmbtQ4k5VPr27h6"); /* DevUSDC deposit */

const pyth_sol_usdc_price = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

// DEVNET設定
const wrapped_sol_mint = new PublicKey("So11111111111111111111111111111111111111112");
const devusdc_mint = new PublicKey("FMwbjM1stnTzi74LV4cS937jeSUds7mZDgcdgnJ1yBDw");

const USDCToken = new Token(connection, devusdc_mint, TOKEN_PROGRAM_ID, wallet);
const WSOLToken = new Token(connection, wrapped_sol_mint, TOKEN_PROGRAM_ID, wallet);

let deposit_sol = null;
let deposit_usdc = null;
let temporary_deposit_wsol = null;
let deposit_wsol = null;
let usdc_token = devusdc_mint;
let wsol_token = wrapped_sol_mint;
let wallet_usdc = null;
let price_info = null;

async function print_balance(msg) {
    console.log("====================", msg, "====================");

    // SOL残高チェック
    const deposit_sol_ai = await connection.getAccountInfo(deposit_sol);
    console.log("\tdeposit_sol lamports", deposit_sol_ai.lamports);
    // wallet
    const wallet_ai = await connection.getAccountInfo(wallet.publicKey);
    console.log("\twallet lamports", wallet_ai.lamports);

    // δUSDC残高チェック
    const deposit_usdc_ai = await USDCToken.getAccountInfo(deposit_usdc);
    console.log("\tdeposit_usdc", deposit_usdc_ai.amount.toString());

    // WSOL残高チェック
    const deposit_wsol_ai = await WSOLToken.getAccountInfo(deposit_wsol);
    console.log("\tdeposit_wsol", deposit_wsol_ai.amount.toString());

    // Orca Pool
    const orca_wsol_ai = await WSOLToken.getAccountInfo(orca_token_A_deposit);
    console.log("\torca_wsol", orca_wsol_ai.amount.toString());
    const orca_usdc_ai = await USDCToken.getAccountInfo(orca_token_B_deposit);
    console.log("\torca_usdc", orca_usdc_ai.amount.toString());

    console.log("--------------------", msg, "--------------------");
}

async function initialize() {
    const transaction = new Transaction();
    const ix = program.instruction.initialize({
        accounts: {
            creator: wallet.publicKey,
            priceInfo: price_info,
            depositSol: deposit_sol,
            depositUsdc: deposit_usdc,
            usdcMint: usdc_token,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
        },
        signers: [wallet],
    });
    transaction.add(ix);

    // 実行
    const tx = await connection.sendTransaction(
        transaction,
        [wallet],
    );
    console.log("\ttx signature", tx);
    await connection.confirmTransaction(tx, commitment);
}

async function update_price() {
  const transaction = new Transaction();
  const ix = program.instruction.updatePrice({
      accounts: {
          creator: wallet.publicKey,
          executor: wallet.publicKey,
          priceInfo: price_info,
          pythSolUsdcPrice: pyth_sol_usdc_price,
          clock: SYSVAR_CLOCK_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

  // 実行
  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function create_pool(index) {
  const [pool_deposit_sol, pool_deposit_usdc] = await get_pool_deposit_address(index);
  console.log("\tindex", index);
  console.log("\tpool_deposit_sol", pool_deposit_sol.toBase58());
  console.log("\tpool_deposit_usdc", pool_deposit_usdc.toBase58());

  const transaction = new Transaction();
  const ix = program.instruction.createPool(
      index, {
      accounts: {
          creator: wallet.publicKey,
          poolDepositSol: pool_deposit_sol,
          poolDepositUsdc: pool_deposit_usdc,
          usdcMint: usdc_token,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

  // 実行
  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function get_kurayashiki_price() {
  const price_info_account_data = await program.account.priceInfo.fetch(price_info);
  return price_info_account_data.currentUsdcPerSolPrice;
}

async function get_pool_deposit_address(index) {
  const [pool_deposit_sol,] = await PublicKey.findProgramAddress(
    [
      Uint8Array.from(Buffer.from("kurayashiki")),
      Uint8Array.from(Buffer.from("nano_swap")),
      Uint8Array.from(Buffer.from("deposit_sol")),
      toUint8Array(index),
      wallet.publicKey.toBytes(),
    ],
    program.programId);

  const pool_deposit_usdc = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    usdc_token,
    pool_deposit_sol,
    true); // authority が PDA の場合は allowOwnerOffCurve = true

  return [pool_deposit_sol, pool_deposit_usdc];
}

async function neutralize(index) {
  // PDA導出
  const [pool_deposit_sol, pool_deposit_usdc] = await get_pool_deposit_address(index);
  console.log("\tindex", index);
  console.log("\tpool_deposit_sol", pool_deposit_sol.toBase58());
  console.log("\tpool_deposit_usdc", pool_deposit_usdc.toBase58());

  const pre_tx_lamports = (await connection.getAccountInfo(wallet.publicKey)).lamports;
  const price = await get_kurayashiki_price();

  console.log("\tpre_tx_lamports", pre_tx_lamports);
  console.log("\tprice (kurayashiki, usdc/sol", price.toNumber());

  const transaction = new Transaction();
  const ix = program.instruction.neutralize(
      index,
      price,
      BN(pre_tx_lamports), {
      accounts: {
          creator: wallet.publicKey,
          priceInfo: price_info,
          poolDepositSol: pool_deposit_sol,
          poolDepositUsdc: pool_deposit_usdc,          
          user: wallet.publicKey,
          userUsdc: wallet_usdc,
          usdcMint: usdc_token,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

  // 実行
  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function rebalance_pool() {
  const index1 = 0;
  const index2 = 1;
  const index3 = 2;
  const index4 = 3;

  const [pool_deposit_sol1, pool_deposit_usdc1] = await get_pool_deposit_address(index1);
  const [pool_deposit_sol2, pool_deposit_usdc2] = await get_pool_deposit_address(index2);
  const [pool_deposit_sol3, pool_deposit_usdc3] = await get_pool_deposit_address(index3);
  const [pool_deposit_sol4, pool_deposit_usdc4] = await get_pool_deposit_address(index4);

  console.log("pool_deposit_sols", pool_deposit_sol1.toBase58(), pool_deposit_sol2.toBase58(), pool_deposit_sol3.toBase58(), pool_deposit_sol4.toBase58());
  console.log("pool_deposit_usdcs", pool_deposit_usdc1.toBase58(), pool_deposit_usdc2.toBase58(), pool_deposit_usdc3.toBase58(), pool_deposit_usdc4.toBase58());

  const transaction = new Transaction();
  const ix = program.instruction.rebalancePool(
      index1, index2, index3, index4, {
      accounts: {
          creator: wallet.publicKey,
          executor: wallet.publicKey,
          depositSol: deposit_sol,
          depositUsdc: deposit_usdc,
          temporaryDepositWsol: temporary_deposit_wsol,

          poolDepositSol1: pool_deposit_sol1,
          poolDepositUsdc1: pool_deposit_usdc1,          
          poolDepositSol2: pool_deposit_sol2,
          poolDepositUsdc2: pool_deposit_usdc2,          
          poolDepositSol3: pool_deposit_sol3,
          poolDepositUsdc3: pool_deposit_usdc3,          
          poolDepositSol4: pool_deposit_sol4,
          poolDepositUsdc4: pool_deposit_usdc4,          

          orcaSwapProgram: ORCA_TOKEN_SWAP_ID_DEVNET,
          orcaAddress: orca_address,
          orcaAuthority: orca_authority,
          orcaPoolWsol: orca_token_A_deposit,
          orcaPoolUsdc: orca_token_B_deposit,
          orcaPoolTokenMint: orca_pool_token_mint,
          orcaFeeAccount: orca_fee_account,

          wsolMint: wrapped_sol_mint,
          usdcMint: devusdc_mint,

          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

  // 実行
  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);

}

/*
async function swap() {
    const input_usdc_amount = new Decimal("0.1");
    const min_sol_amount = await getQuote(input_usdc_amount);
    console.log("input_usdc_amount", input_usdc_amount);
    console.log("min_sol_amount", min_sol_amount, min_sol_amount.toDecimal());

    const micro_usdc = input_usdc_amount.toDecimalPlaces(6).mul(new Decimal(10).pow(6));
    console.log("micro_usdc", micro_usdc);
    //const lamports = new Decimal(min_sol_amount.toDecimal().toString());
    const lamports = min_sol_amount.toDecimal().toDecimalPlaces(9).mul(new Decimal(10).pow(9));
    console.log("lamports", lamports);

    console.log("swap", micro_usdc.toString(), " mUSDC to ", lamports.toString(), "lamports");

    const transaction = new Transaction();
    const ix = program.instruction.swap(
        BN(micro_usdc.toNumber()),
        BN(lamports.toNumber()), {
        accounts: {
            creator: wallet.publicKey,
            depositSol: deposit_sol,
            depositUsdc: deposit_usdc,
            depositWsol: deposit_wsol,
            authorityWsol: authority_wsol,
            user: wallet.publicKey,
            userUsdc: wallet_usdc,
            orcaSwapProgram: ORCA_TOKEN_SWAP_ID_DEVNET,
            orcaAddress: orca_address,
            orcaAuthority: orca_authority,
            orcaPoolWsol: orca_token_A_deposit,
            orcaPoolUsdc: orca_token_B_deposit,
            orcaPoolTokenMint: orca_pool_token_mint,
            orcaFeeAccount: orca_fee_account,
            wsolMint: wrapped_sol_mint,
            usdcMint: devusdc_mint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [wallet],
    });
    transaction.add(ix);

    // 実行
    const tx = await connection.sendTransaction(
        transaction,
        [wallet],
    );
    console.log("\ttx signature", tx);
    await connection.confirmTransaction(tx, commitment);
}

async function unwrap() {
  console.log("unwrap wsol to sol");

  const transaction = new Transaction();
  const ix = program.instruction.unwrap({
      accounts: {
          creator: wallet.publicKey,
          depositSol: deposit_sol,
          depositWsol: deposit_wsol,
          authorityWsol: authority_wsol,
          wsolMint: wrapped_sol_mint,
          temporaryWsol: temporary_wsol,
          // いらない
          usdcMint: devusdc_mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

  // 実行
  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}


async function getQuote(input_usdc_amount: Decimal) {
    const devusdc_pubkey = new PublicKey("FMwbjM1stnTzi74LV4cS937jeSUds7mZDgcdgnJ1yBDw");
    const sol_devusdc_pool_params: OrcaPoolParams = Object.freeze({
        // create_devnet_orca_pool.ts で作った情報を入れる
        address: new PublicKey("3CbxF5jLJux7JwRceWkfLZZME8jFZWenvHwwo3ko2XKg"),
        nonce: 253,
        authority: new PublicKey("22b7ZrVsaY7jrvYeGv5DqbZR5rqYTRFocc97TYAawhjp"),
        poolTokenMint: new PublicKey("B3jS5cq1rVGXN4smYoAagq9UtYJcKxA6P5buaRBpsRXb"),
        poolTokenDecimals: 6,
        feeAccount: new PublicKey("2Fqu8eq8fFLjgyTB5cZAZt3bTMJw48oT2Np6dkJKhcB6"),
        tokenIds: [Tokens.solToken.mint.toString(), devusdc_pubkey.toString()],
        tokens: {
          [Tokens.solToken.mint.toString()]: {
            ...Tokens.solToken,
            addr: new PublicKey("6QRQnqSUDdgjWSpdXizK2hZ8HKfLiDogDaF1Edkq32Ev"),
          },
          [devusdc_pubkey.toString()]: {
            // ...で展開されるJSONフィールドを直接入力
            // https://github.com/orca-so/typescript-sdk/blob/main/src/constants/tokens.ts
            tag: "DevUSDC",
            name: "Devnet USD Coin",
            mint: devusdc_pubkey,
            scale: 6,
            addr: new PublicKey("3mdEwkuwPEQyEG2qRH23khcb6xDvqfmbtQ4k5VPr27h6"),
          },
        },
        curveType: CurveType.ConstantProduct,
        feeStructure: {
          traderFee: Percentage.fromFraction(25, 10000),
          ownerFee: Percentage.fromFraction(5, 10000),
        },
    });

    const sol_devusdc_pool = new OrcaPoolImpl(connection, Network.DEVNET, sol_devusdc_pool_params);

    const devusdc_token = sol_devusdc_pool.getTokenB();
    const quote = await sol_devusdc_pool.getQuote(devusdc_token, input_usdc_amount);
    return quote.getMinOutputAmount();
}
*/

function toUint8Array(num) {
    let arr = new ArrayBuffer(4); // an Int32 takes 4 bytes
    let view = new DataView(arr);
    view.setUint32(0, num, true); // byteOffset = 0; litteEndian = true
    console.log(arr);
    return new Uint8Array(arr);
}

async function main() {
    console.log("programId: ", program.programId.toBase58());

    // PDA導出
    [deposit_sol,] = await PublicKey.findProgramAddress(
        [
          Uint8Array.from(Buffer.from("kurayashiki")),
          Uint8Array.from(Buffer.from("nano_swap")),
          Uint8Array.from(Buffer.from("deposit_sol")),
          /*toUint8Array(0),*/
          wallet.publicKey.toBytes(),
        ],
        program.programId);
      console.log("\tdeposit_sol", deposit_sol.toBase58());
  
      deposit_usdc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdc_token,
        deposit_sol,
        true); // authority が PDA の場合は allowOwnerOffCurve = true
      console.log("\tdeposit_usdc", deposit_usdc.toBase58());

      [temporary_deposit_wsol,] = await PublicKey.findProgramAddress(
        [
          Uint8Array.from(Buffer.from("kurayashiki")),
          Uint8Array.from(Buffer.from("nano_swap")),
          Uint8Array.from(Buffer.from("temporary_deposit_wsol")),
          wallet.publicKey.toBytes(),
        ],
        program.programId);
      console.log("\ttemporary_deposit_wsol", temporary_deposit_wsol.toBase58());
      
      [price_info,] = await PublicKey.findProgramAddress(
        [
          Uint8Array.from(Buffer.from("kurayashiki")),
          Uint8Array.from(Buffer.from("nano_swap")),
          Uint8Array.from(Buffer.from("price_info")),
          wallet.publicKey.toBytes(),
        ],
        program.programId);
      console.log("\tprice_info", price_info.toBase58());
    
    wallet_usdc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        devusdc_mint,
        wallet.publicKey,
        false);
    console.log("\twallet_usdc", wallet_usdc.toBase58());

    //await initialize();
    // https://solscan.io/tx/z2QZhKj1dcArQ9k4Q11hDQQFwN9y6C1PC2xSuubWb3hqNH3KjuVmDZ9vNXCj9YUNJzfHRBjN6Vpwpcjcnpcy2yk?cluster=devnet

    //await update_price();
    // https://solscan.io/tx/4hhba3CmNwcEErJbpB9jEvm8un113EMZ2LPDFSodZoGC8AwXVCkR4uGzg2722NXeca4YtnpQnBVSPotGaP1C4xva?cluster=devnet
    // https://solscan.io/tx/MYQ7HSoxc1Y7KvDKF9soTSyCyDFgg7CUYm4Tqqwvs6hEFW9grYAoNfNKCY8oL2moaJqY5UkyUVXVDMEHvs7UaFY?cluster=devnet

    //await create_pool(0);
    //await create_pool(1);
    //await create_pool(2);
    //await create_pool(3);
    // 0: https://solscan.io/tx/38TxgYQX9hoQp5PXZfm7tS8uZ2aUhqT9mktSpnnDZuMkG26rCFdnYWUN74SRQ633KieYnSicitXqYL13H7yDUCcH?cluster=devnet
    // 1: https://solscan.io/tx/9EdyqbSJZ1YVwbfVCcYJdAY5eit2f1WFeCrkc8GKnRj7G6TmLG1VTiCVkJiwEQ3aRr73U8KvPJiBRyFmbHACFZ8?cluster=devnet
    // 2: https://solscan.io/tx/2g9m7PHd9bFK2hd4HJrPtnL5JkgW5HoH8EgXZv2GjNNicyzRqDsut9BiSZaDzZsyxr8terWsZehMCfm6oN3CfzSw?cluster=devnet
    // 3: https://solscan.io/tx/3aBMF6i9W2cCqZDTmQRfwQFcWgqEjiHPgMeEj3e67Ghv2GS5zXoXoBQufAas21pAYWDxGzhGHWqYVJfEHxCuyZgH?cluster=devnet

    // await neutralize(1);


    await rebalance_pool();

}

main();