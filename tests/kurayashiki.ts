import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Kurayashiki } from '../target/types/kurayashiki';

describe('kurayashiki', () => {

  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.Provider.env());

  const program = anchor.workspace.Kurayashiki as Program<Kurayashiki>;

  it('Is initialized!', async () => {
    // Add your test here.
    const tx = await program.rpc.initialize({});
    console.log("Your transaction signature", tx);
  });
});
