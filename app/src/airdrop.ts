import * as idl from '../../../airdrop/target/idl/airdrop.json';
import type { Airdrop } from '../../../airdrop/target/types/airdrop';

import { Keypair, Connection, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { Idl, Program, Provider, BN as AnchorBN } from '@project-serum/anchor';

const BN = (n:number) => { return new AnchorBN(n); } 

const RPC_ENDPOINT_URL = "https://api.devnet.solana.com";
const AIRDROP_PROGRAM_ID = new PublicKey("EZz9sdp4LGfyDMsYfGssJMxYWGBQAEBZzig51PVPgpu1");

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
const program = new Program(idl as Idl, AIRDROP_PROGRAM_ID, provider) as Program<Airdrop>;

const pyth_sol_usdc_price = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

// DEVNET設定
const wrapped_sol_mint = new PublicKey("So11111111111111111111111111111111111111112");
const devusdc_mint = new PublicKey("FMwbjM1stnTzi74LV4cS937jeSUds7mZDgcdgnJ1yBDw");
const devkura_mint = new PublicKey("AbixiHWAh6W7rtj7jKqV4Lt73kZWy5usanioVZjvPoqe");

const USDCToken = new Token(connection, devusdc_mint, TOKEN_PROGRAM_ID, wallet);
const KURAToken = new Token(connection, devkura_mint, TOKEN_PROGRAM_ID, wallet);
const WSOLToken = new Token(connection, wrapped_sol_mint, TOKEN_PROGRAM_ID, wallet);

let authority = null;
let deposit_usdc = null;
let deposit_kura = null;
let wallet2_usdc = null;
let wallet2_kura = null;

async function initialize() {
    const transaction = new Transaction();
    const ix = program.instruction.initialize({
        accounts: {
            authority: authority,
            payer: wallet.publicKey,
            depositUsdc: deposit_usdc,
            depositKura: deposit_kura,
            usdcMint: devusdc_mint,
            kuraMint: devkura_mint,
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

async function airdrop() {
  const transaction = new Transaction();
  const ix = program.instruction.airdrop({
      accounts: {
          authority: authority,
          depositUsdc: deposit_usdc,
          depositKura: deposit_kura,
          userUsdc: wallet2_usdc,
          userKura: wallet2_kura,
          usdcMint: devusdc_mint,
          kuraMint: devkura_mint,
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

async function main() {
    console.log("programId: ", program.programId.toBase58());

    // PDA導出
    [authority,] = await PublicKey.findProgramAddress(
        [
          Uint8Array.from(Buffer.from("kurayashiki_airdrop")),
        ],
        program.programId);
    console.log("\tauthority", authority.toBase58());
  
    deposit_usdc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        devusdc_mint,
        authority,
        true); // authority が PDA の場合は allowOwnerOffCurve = true
    console.log("\tdeposit_usdc", deposit_usdc.toBase58());

    deposit_kura = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      devkura_mint,
      authority,
      true); // authority が PDA の場合は allowOwnerOffCurve = true
    console.log("\tdeposit_kura", deposit_kura.toBase58());

    wallet2_usdc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        devusdc_mint,
        wallet2.publicKey,
        false);
    console.log("\twallet2_usdc", wallet2_usdc.toBase58());

    wallet2_kura = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      devkura_mint,
      wallet2.publicKey,
      false);
    console.log("\twallet2_kura", wallet2_kura.toBase58());

    // await initialize();
    // https://solscan.io/tx/2NJzws3DCAXw1p3uzigRPhYEgAew3uCnFb5jVZPNTzFkoip9N3C2d3n6qX97ch4VStTJuh1tadVjg8hWZXZH39Tq?cluster=devnet

    // await airdrop();
    // https://solscan.io/tx/4HB1Kz6BFnbV4817vZDwTSpPEeAX3wLDxiLaTfFuaVPXKnDz3Zu6QfZKohYTwJpsWorNbvFBZHnCsvD9g1snZWia?cluster=devnet
}

main();