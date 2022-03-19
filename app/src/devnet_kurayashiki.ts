import * as idl from '../../target/idl/kurayashiki.json';
import type { Kurayashiki } from '../../target/types/kurayashiki';

import { Keypair, Connection, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { Idl, Program, Provider, Wallet, BN as AnchorBN } from '@project-serum/anchor';
import { ORCA_TOKEN_SWAP_ID, ORCA_TOKEN_SWAP_ID_DEVNET, Network } from '@orca-so/sdk';
import Decimal from 'decimal.js';

const BN = (n:number) => { return new AnchorBN(n); } 

const RPC_ENDPOINT_URL = "https://api.devnet.solana.com";
const KURAYASHIKI_PROGRAM_ID = new PublicKey("F3jaebcEGakVPRagMXGZ13iPSnH5XUiwW35A5LCe1eVe");

const commitment = 'confirmed';
const connection = new Connection(RPC_ENDPOINT_URL, commitment);
const secret = Uint8Array.from(JSON.parse(require("fs").readFileSync("/Users/ikeyanagi/.config/solana/id1.json")));
const wallet = Keypair.fromSecretKey(secret as Uint8Array);
const secret2 = Uint8Array.from(JSON.parse(require("fs").readFileSync("/Users/ikeyanagi/.config/solana/id2.json")));
const wallet2 = Keypair.fromSecretKey(secret2 as Uint8Array);

const provider = new Provider(connection, new Wallet(wallet), { preflightCommitment: commitment });
const program = new Program(idl as Idl, KURAYASHIKI_PROGRAM_ID, provider) as Program<Kurayashiki>;

const orca_address = new PublicKey("DosfiDxjKb9b3XAuqwZ8cbg7F9iWtuew1PpKrkXUxi1V");
const orca_authority = new PublicKey("EAj5W6dVep8xK5MXgu22sD28cBWLmGc3GL963sMVod44");
const orca_pool_token_mint = new PublicKey("7AEdkVjrFAfYMgJTRW7VAXyxiq7652t8eQWa5JcDL7fM");
const orca_fee_account = new PublicKey("67kMLL5ezDoxRD3PAtNP1LDE9oV4archrmNeePySHLQ");
const orca_token_A_deposit = new PublicKey("C3cMYaFPADiGYJjdYTZ7PiuduMuuGLRV3Nsdo1N1m1xo"); /* WSOL deposit */
const orca_token_B_deposit = new PublicKey("GKmRB5Zpq77aws79YDZ3Ekke4x5g6mBJqCq86vy36Yqe"); /* DevUSDC deposit */

const pyth_sol_usdc_price = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

// DEVNET accounts
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
          priceInfo: price_info,
          pythSolUsdcPrice: pyth_sol_usdc_price,
          clock: SYSVAR_CLOCK_PUBKEY,
      },
      signers: [wallet],
  });
  transaction.add(ix);

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
    true); // true if authority is PDA

  return [pool_deposit_sol, pool_deposit_usdc];
}

async function neutralize(index) {
  // PDA
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

  const tx = await connection.sendTransaction(
      transaction,
      [wallet],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function collect_from_pool(index1, index2, index3, index4) {
  const [pool_deposit_sol1, pool_deposit_usdc1] = await get_pool_deposit_address(index1);
  const [pool_deposit_sol2, pool_deposit_usdc2] = await get_pool_deposit_address(index2);
  const [pool_deposit_sol3, pool_deposit_usdc3] = await get_pool_deposit_address(index3);
  const [pool_deposit_sol4, pool_deposit_usdc4] = await get_pool_deposit_address(index4);

  console.log("pool_deposit_sols", pool_deposit_sol1.toBase58(), pool_deposit_sol2.toBase58(), pool_deposit_sol3.toBase58(), pool_deposit_sol4.toBase58());
  console.log("pool_deposit_usdcs", pool_deposit_usdc1.toBase58(), pool_deposit_usdc2.toBase58(), pool_deposit_usdc3.toBase58(), pool_deposit_usdc4.toBase58());

  const transaction = new Transaction();
  const ix = program.instruction.collectFromPool(
      index1, index2, index3, index4, {
      accounts: {
          creator: wallet.publicKey,
          depositSol: deposit_sol,
          depositUsdc: deposit_usdc,

          poolDepositSol1: pool_deposit_sol1,
          poolDepositUsdc1: pool_deposit_usdc1,          
          poolDepositSol2: pool_deposit_sol2,
          poolDepositUsdc2: pool_deposit_usdc2,          
          poolDepositSol3: pool_deposit_sol3,
          poolDepositUsdc3: pool_deposit_usdc3,          
          poolDepositSol4: pool_deposit_sol4,
          poolDepositUsdc4: pool_deposit_usdc4,          

          usdcMint: devusdc_mint,
          tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [],
  });
  transaction.add(ix);
  transaction.feePayer = wallet2.publicKey;

  const tx = await connection.sendTransaction(
      transaction,
      [wallet2],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function distribute_to_pool(index1, index2, index3, index4) {
  const [pool_deposit_sol1, pool_deposit_usdc1] = await get_pool_deposit_address(index1);
  const [pool_deposit_sol2, pool_deposit_usdc2] = await get_pool_deposit_address(index2);
  const [pool_deposit_sol3, pool_deposit_usdc3] = await get_pool_deposit_address(index3);
  const [pool_deposit_sol4, pool_deposit_usdc4] = await get_pool_deposit_address(index4);

  console.log("pool_deposit_sols", pool_deposit_sol1.toBase58(), pool_deposit_sol2.toBase58(), pool_deposit_sol3.toBase58(), pool_deposit_sol4.toBase58());
  console.log("pool_deposit_usdcs", pool_deposit_usdc1.toBase58(), pool_deposit_usdc2.toBase58(), pool_deposit_usdc3.toBase58(), pool_deposit_usdc4.toBase58());

  const transaction = new Transaction();
  const ix = program.instruction.distributeToPool(
      index1, index2, index3, index4, {
      accounts: {
          creator: wallet.publicKey,
          depositSol: deposit_sol,

          poolDepositSol1: pool_deposit_sol1,
          poolDepositSol2: pool_deposit_sol2,
          poolDepositSol3: pool_deposit_sol3,
          poolDepositSol4: pool_deposit_sol4,

          systemProgram: SystemProgram.programId,
      },
      signers: [],
  });
  transaction.add(ix);
  transaction.feePayer = wallet2.publicKey;

  const tx = await connection.sendTransaction(
      transaction,
      [wallet2],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

async function convert_to_sol() {
  const transaction = new Transaction();
  const ix = program.instruction.convertToSol({
      accounts: {
          creator: wallet.publicKey,
          depositSol: deposit_sol,
          depositUsdc: deposit_usdc,
          temporaryDepositWsol: temporary_deposit_wsol,

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
      signers: [],
  });
  transaction.add(ix);
  transaction.feePayer = wallet2.publicKey;

  const tx = await connection.sendTransaction(
      transaction,
      [wallet2],
  );
  console.log("\ttx signature", tx);
  await connection.confirmTransaction(tx, commitment);
}

function toUint8Array(num) {
    let arr = new ArrayBuffer(4); // an Int32 takes 4 bytes
    let view = new DataView(arr);
    view.setUint32(0, num, true); // byteOffset = 0; litteEndian = true
    console.log(arr);
    return new Uint8Array(arr);
}

async function main() {
    console.log("programId: ", program.programId.toBase58());

    // PDA
    [deposit_sol,] = await PublicKey.findProgramAddress(
        [
          Uint8Array.from(Buffer.from("kurayashiki")),
          Uint8Array.from(Buffer.from("nano_swap")),
          Uint8Array.from(Buffer.from("deposit_sol")),
          wallet.publicKey.toBytes(),
        ],
        program.programId);
      console.log("\tdeposit_sol", deposit_sol.toBase58());
  
      deposit_usdc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdc_token,
        deposit_sol,
        true); // true if authority is PDA
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

    //await create_pool(0);
    //await create_pool(1);
    //await create_pool(2);
    //await create_pool(3);
    //await create_pool(4);
    //await create_pool(5);
    //await create_pool(6);
    //await create_pool(7);
    // 0: https://solscan.io/tx/38TxgYQX9hoQp5PXZfm7tS8uZ2aUhqT9mktSpnnDZuMkG26rCFdnYWUN74SRQ633KieYnSicitXqYL13H7yDUCcH?cluster=devnet
    // 1: https://solscan.io/tx/9EdyqbSJZ1YVwbfVCcYJdAY5eit2f1WFeCrkc8GKnRj7G6TmLG1VTiCVkJiwEQ3aRr73U8KvPJiBRyFmbHACFZ8?cluster=devnet
    // 2: https://solscan.io/tx/2g9m7PHd9bFK2hd4HJrPtnL5JkgW5HoH8EgXZv2GjNNicyzRqDsut9BiSZaDzZsyxr8terWsZehMCfm6oN3CfzSw?cluster=devnet
    // 3: https://solscan.io/tx/3aBMF6i9W2cCqZDTmQRfwQFcWgqEjiHPgMeEj3e67Ghv2GS5zXoXoBQufAas21pAYWDxGzhGHWqYVJfEHxCuyZgH?cluster=devnet
    // 4: https://solscan.io/tx/Q4xFeD6TVMB6d9C1ytqUXuvpAdruaUFcH4SYothiS3hzdmdNzciRCe95e8hmJatGZJ8jPWGQsYQ2WF1TShFBvbh?cluster=devnet
    // 5: https://solscan.io/tx/rFnRvTETbW5mXnSUBz5LngQ8C6Met6MMsW1TZ5F3sjC1BiMCiyHE3x5JfRQzw3DQW4MwoWTZddJaUVAbSy1572W?cluster=devnet
    // 6: https://solscan.io/tx/3wt8fTq6WzTPSXGeejtWPN4HtFE3f9856YP3apaA56GpCuTYeLRDox2bA7hADmpK7J76UBEeX1UuEb7FVkxJ74sd?cluster=devnet
    // 7: https://solscan.io/tx/bkJSnXsEo1igqW1hBeLZuA6rbZfQS3X3EUCJVQ2guAimLsQsMnUCaanwVCDMZjmgBxHafYPN2bAwQZsYyM1xSXa?cluster=devnet

    await update_price();
    // https://solscan.io/tx/4hhba3CmNwcEErJbpB9jEvm8un113EMZ2LPDFSodZoGC8AwXVCkR4uGzg2722NXeca4YtnpQnBVSPotGaP1C4xva?cluster=devnet
    // https://solscan.io/tx/MYQ7HSoxc1Y7KvDKF9soTSyCyDFgg7CUYm4Tqqwvs6hEFW9grYAoNfNKCY8oL2moaJqY5UkyUVXVDMEHvs7UaFY?cluster=devnet

    await neutralize(0);
    await neutralize(1);
    await neutralize(2);
    await neutralize(3);
    await neutralize(4);
    await neutralize(5);
    await neutralize(6);
    await neutralize(7);

    await collect_from_pool(0, 1, 2, 3);
    // https://solscan.io/tx/3jHAy9FVJXX7SvqaXVk93xM9uyeBJVErp42fgDX5oyzeMtLngKyth7vfA3nUAK68h2r8mUwVfKFmoYxjNaXyt9gT?cluster=devnet
    // https://solscan.io/tx/mzVuVv9CJsSA6pjnJ6MX9iwzBqRYwDWz6us6thkWwE6uKwTKFu6rnfo7RSnyXFt18tWb1ocL9WEsZbJzX7CC3Rg?cluster=devnet
    await collect_from_pool(4, 5, 6, 7);
    // https://solscan.io/tx/5mXSjdREah84tnMsBwCJ49SFy8jubgQKzDiNoYgDPVxXNiV4wEyR8wLq5epeDDEt83HZHK8ZzwvKRcCqETd3tPwS?cluster=devnet
    // https://solscan.io/tx/4dmXTjAorM8DxNGouqkmaNzKDeNLPf8r8L7pUYpNRYFRrRHJZ7vA15dEq1qsZNADvGGQWtypn6nfB6dVpVyhDjFU?cluster=devnet

    await convert_to_sol();
    // https://solscan.io/tx/3s732sQ673711vdXktmwS73n2rXpsFvSThTiXSx7DTjRVnqvcz3vsLb5obfwkjervSmMrZcMPR4Gd4LZGvtScnY9?cluster=devnet
    // https://solscan.io/tx/2gMPQwDPEuATcaePmWVqa1egk9AeuawmRHbGm24RRpUndzvUfEX4qx7jQpMy1UaVNEpy6vbAD9XUdHyxJSazTh75?cluster=devnet

    await distribute_to_pool(0, 1, 2, 3);
    // https://solscan.io/tx/39oubv32d4SVtN6e2p41ALSEyCY6akiGNEWxpGX3G1PgtrxmJk3gxTiRgJHAy5ScRrixEVoP8PDZgGE9N8DuXHh5?cluster=devnet
    // https://solscan.io/tx/pKekYsH6ZDHPLRn82uoUfAWvdzehZyp234N3FJzM2qyM8Zo8voCTaEzHBtVcnnw91GU2WguH3BDoXdxyNttfeCT?cluster=devnet
    await distribute_to_pool(4, 5, 6, 7);
    // https://solscan.io/tx/36QuHPbMR8LyHipGMpkq6vTptp2gUCb5dQ1R54uxKvXVeNiuQmSV79YqpbQrLjQohUKC3aN6QzDJg3DMfE9vf5kz?cluster=devnet
    // https://solscan.io/tx/5kGcGgAutWkP3NQ7Nvdck8ouCnB5u2i1KzwHhvbo4kk7RF86UV8ADcLJUFqNRcGizR1YKoB14nmyzyTXsAytPW1K?cluster=devnet

/*
    for (let i=0; i<8; i++) {
        let [sol, usdc] = await get_pool_deposit_address(i);
        console.log(i, sol.toBase58(), usdc.toBase58()); 
    }
*/
}

main();