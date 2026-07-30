import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

describe('KeypairSigner', () => {
  it('signs a transaction', async () => {
    const kp = Keypair.random();
    const { KeypairSigner } = await import('../signer.js');
    const signer = new KeypairSigner(kp);
    const tx = { sign: vi.fn() } as any;
    signer.sign(tx);
    expect(tx.sign).toHaveBeenCalledWith(kp);
  });

  it('returns public key', async () => {
    const kp = Keypair.random();
    const { KeypairSigner } = await import('../signer.js');
    const signer = new KeypairSigner(kp);
    expect(signer.publicKey()).toBe(kp.publicKey());
  });
});

describe('TransactionSigner', () => {
  it('throws on _signTypedData after destroy', async () => {
    const { TransactionSigner } = await import('../signer.js');
    const signer = new TransactionSigner();
    signer.cleanup();
    await expect(
      (signer as any)._signTypedData({}, {}, {}),
    ).rejects.toThrow('TransactionSigner has been destroyed');
  });

  it('throws on signProposal after destroy', async () => {
    const { TransactionSigner } = await import('../signer.js');
    const signer = new TransactionSigner();
    signer.cleanup();
    await expect(
      signer.signProposal([]),
    ).rejects.toThrow('TransactionSigner has been destroyed');
  });

  it('publicKey returns mock key', async () => {
    const { TransactionSigner } = await import('../signer.js');
    const signer = new TransactionSigner();
    expect(signer.publicKey()).toBe('GTRANSACTIONSIGNERMOCKKEY');
  });

  it('rejects when wallet adapter returns null tx', async () => {
    const { TransactionSigner } = await import('../signer.js');
    const signer = new TransactionSigner({
      walletAdapter: {
        getPublicKey: () => 'G...',
        signTransaction: async () => null as any,
      },
    });
    await expect(signer.sign({} as any)).rejects.toThrow('null or undefined');
  });

  it('rejects when sign throws', async () => {
    const { TransactionSigner } = await import('../signer.js');
    const signer = new TransactionSigner({
      walletAdapter: {
        getPublicKey: () => 'G...',
        signTransaction: async () => { throw new Error('wallet error'); },
      },
    });
    await expect(signer.sign({} as any)).rejects.toThrow('wallet error');
  });
});
