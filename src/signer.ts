import { Keypair, Transaction } from '@stellar/stellar-sdk';

export interface Signer {
  /**
   * Sign `tx`. An implementation may either mutate `tx` in place and return
   * `void`, or return a new signed `Transaction` (the immutable pattern).
   * `StreamsModule._signTx` uses the return value when it is a `Transaction`
   * and falls back to the passed `tx` otherwise.
   */
  sign(tx: Transaction): Transaction | void | Promise<Transaction | void>;
  publicKey(): string;
}

export class KeypairSigner implements Signer {
  constructor(private readonly keypair: Keypair) {}
  sign(tx: Transaction): void {
    tx.sign(this.keypair);
  }
  publicKey(): string {
    return this.keypair.publicKey();
  }
}

