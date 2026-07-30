/**
 * KeypairWalletAdapter wraps a raw @stellar/stellar-sdk Keypair behind the
 * WalletAdapter interface, but had no dedicated test file — the whole
 * signTransaction() branch for raw XDR strings (its main reason for
 * existing over just calling tx.sign(keypair) directly) was untested.
 */

import { describe, it, expect } from 'vitest';
import { Account, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { KeypairWalletAdapter } from '../adapters/keypair.js';

function buildUnsignedTx(sourceKeypair: Keypair): Transaction {
  const account = new Account(sourceKeypair.publicKey(), '100');
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '101' }))
    .setTimeout(30)
    .build();
}

describe('KeypairWalletAdapter', () => {
  it('getPublicKey() returns the keypair\'s public key', () => {
    const keypair = Keypair.random();
    const adapter = new KeypairWalletAdapter(keypair);

    expect(adapter.getPublicKey()).toBe(keypair.publicKey());
  });

  it('isConnected() is always true — a local keypair has no session', () => {
    const adapter = new KeypairWalletAdapter(Keypair.random());
    expect(adapter.isConnected()).toBe(true);
  });

  it('signTransaction() signs and returns a Transaction instance', async () => {
    const keypair = Keypair.random();
    const adapter = new KeypairWalletAdapter(keypair);
    const tx = buildUnsignedTx(keypair);

    expect(tx.signatures).toHaveLength(0);

    const signed = await adapter.signTransaction(tx);

    expect(signed).toBe(tx);
    expect((signed as Transaction).signatures).toHaveLength(1);
  });

  it('signTransaction() signs a raw XDR string given a networkPassphrase, returning signed XDR', async () => {
    const keypair = Keypair.random();
    const adapter = new KeypairWalletAdapter(keypair);
    const tx = buildUnsignedTx(keypair);
    const unsignedXdr = tx.toXDR();

    const result = await adapter.signTransaction(unsignedXdr, { networkPassphrase: Networks.TESTNET });

    expect(typeof result).toBe('string');
    const decoded = TransactionBuilder.fromXDR(result as string, Networks.TESTNET);
    expect((decoded as Transaction).signatures).toHaveLength(1);
  });

  it('signTransaction() rejects a raw XDR string without networkPassphrase', async () => {
    const keypair = Keypair.random();
    const adapter = new KeypairWalletAdapter(keypair);
    const tx = buildUnsignedTx(keypair);

    await expect(adapter.signTransaction(tx.toXDR())).rejects.toThrow(
      /networkPassphrase is required/,
    );
  });

  it('signTransaction() ignores accountToSign — the keypair always signs as itself', async () => {
    const keypair = Keypair.random();
    const otherAccount = Keypair.random().publicKey();
    const adapter = new KeypairWalletAdapter(keypair);
    const tx = buildUnsignedTx(keypair);

    const signed = (await adapter.signTransaction(tx, {
      networkPassphrase: Networks.TESTNET,
      accountToSign: otherAccount,
    })) as Transaction;

    expect(signed.signatures).toHaveLength(1);
    expect(keypair.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });
});
