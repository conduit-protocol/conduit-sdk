import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr, Keypair, nativeToScVal, Address } from '@stellar/stellar-sdk';

const {
  mockSimulateTransaction,
  mockGetAccount,
  mockSendTransaction,
  mockGetTransaction,
  mockAssembleTransaction,
} = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockGetTransaction: vi.fn(),
  mockAssembleTransaction: vi.fn(),
}));

const VALID_CONTRACT = (() => {
  const { StrKey } = require('@stellar/stellar-sdk');
  const buf = Buffer.alloc(32);
  require('crypto').randomFillSync(buf);
  return StrKey.encodeContract(buf);
})();

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return {
          getAccount: mockGetAccount,
          simulateTransaction: mockSimulateTransaction,
          sendTransaction: mockSendTransaction,
          getTransaction: mockGetTransaction,
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
      assembleTransaction: mockAssembleTransaction,
    },
  };
});

vi.mock('../factory.js', () => {
  return {
    FactoryModule: class {
      streamAddress = vi.fn().mockResolvedValue(VALID_CONTRACT);
      streamCount = vi.fn().mockResolvedValue(42n);
      streamsBySender = vi.fn().mockResolvedValue([1n, 2n, 3n]);
      streamsByRecipient = vi.fn().mockResolvedValue([1n, 2n]);
      protocolFeeBps = vi.fn().mockResolvedValue(30);
    } as any,
  };
});

import { SorobanRpc } from '@stellar/stellar-sdk';
import { StreamsModule } from '../streams.js';
import type { ConduitConfig } from '../types/index.js';

describe('StreamsModule — edge cases', () => {
  let config: ConduitConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    const { Account, Keypair } = require('@stellar/stellar-sdk');
    const pk = Keypair.random().publicKey();
    mockGetAccount.mockResolvedValue(new Account(pk, '1'));
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => xdr.ScVal.scvMap([]).toXDR() } },
    });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: '0'.repeat(64) });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue: xdr.ScVal.scvVoid() });
    mockAssembleTransaction.mockReturnValue({ build: vi.fn().mockReturnValue({ sign: vi.fn() }) });

    config = {
      network: 'testnet',
      factoryAddress: VALID_CONTRACT,
      keypair: {
        publicKey: () => 'GBOGNMY4GQI7S6K5C5B4PH2FWZ3K2GXN4AAAAA',
        sign: vi.fn(),
      } as any,
    };
  });

  describe('_sendAndPoll', () => {
    it('handles ERROR status from sendTransaction', async () => {
      mockSendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: { message: 'insufficient fee' },
      });

      const streams = new StreamsModule(config);
      const server = new SorobanRpc.Server('http://localhost:8000');
      const tx = { toXDR: () => '' } as any;
      await expect((streams as any)._sendAndPoll(server, tx)).rejects.toThrow(
        'Transaction rejected',
      );
    });

    it('handles FAILED status from getTransaction', async () => {
      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: '0'.repeat(64) });
      mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

      const streams = new StreamsModule(config);
      const server = new SorobanRpc.Server('http://localhost:8000');
      const tx = { toXDR: () => '' } as any;
      await expect((streams as any)._sendAndPoll(server, tx)).rejects.toThrow(
        'Transaction failed',
      );
    });

    it('continues polling on NOT_FOUND', async () => {
      let callCount = 0;
      mockGetTransaction.mockImplementation(() => {
        callCount++;
        if (callCount < 3) return { status: 'NOT_FOUND' };
        return { status: 'SUCCESS', returnValue: xdr.ScVal.scvVoid() };
      });

      const streams = new StreamsModule(config);
      const server = new SorobanRpc.Server('http://localhost:8000');
      const tx = { toXDR: () => '' } as any;
      const result = await (streams as any)._sendAndPoll(server, tx);
      expect(result.hash).toBe('0'.repeat(64));
    });

    it('throws on transaction timeout', async () => {
      mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

      const streams = new StreamsModule({
        ...config,
        confirmationMaxAttempts: 2,
        confirmationPollIntervalMs: 1,
      });
      const server = new SorobanRpc.Server('http://localhost:8000');
      const tx = { toXDR: () => '' } as any;
      await expect((streams as any)._sendAndPoll(server, tx)).rejects.toThrow(
        'Transaction timed out',
      );
    });
  });

  describe('_signerPublicKey fallbacks', () => {
    it('uses keypair when no wallet or signer', () => {
      const streams = new StreamsModule(config);
      expect((streams as any)._signerPublicKey()).toBe(config.keypair!.publicKey());
    });

    it('uses wallet public key', () => {
      const wallet = { getPublicKey: () => 'GWALLET123' };
      const streams = new StreamsModule({ ...config, wallet: wallet as any });
      expect((streams as any)._signerPublicKey()).toBe('GWALLET123');
    });

    it('uses signer when no wallet', () => {
      const cfg = { ...config };
      delete cfg.keypair;
      const streams = new StreamsModule({ ...cfg, signer: { sign: vi.fn(), publicKey: () => 'GSIGNER' } as any });
      expect((streams as any)._signerPublicKey()).toBe('GSIGNER');
    });
  });

  describe('_resolveCallerAddress', () => {
    it('falls back to keypair when wallet returns null', async () => {
      const wallet = { getPublicKey: vi.fn().mockResolvedValue(null) };
      const streams = new StreamsModule({ ...config, wallet: wallet as any });
      const addr = await (streams as any)._resolveCallerAddress();
      expect(addr).toBe(config.keypair!.publicKey());
    });

    it('returns ZERO_ADDR with no auth', async () => {
      const bareConfig: ConduitConfig = { network: 'testnet', factoryAddress: VALID_CONTRACT };
      const streams = new StreamsModule(bareConfig);
      const addr = await (streams as any)._resolveCallerAddress();
      expect(addr).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    });

    it('uses wallet public key', async () => {
      const wallet = { getPublicKey: vi.fn().mockResolvedValue('GWALLET') };
      const streams = new StreamsModule({ ...config, wallet: wallet as any });
      const addr = await (streams as any)._resolveCallerAddress();
      expect(addr).toBe('GWALLET');
    });
  });

  describe('_ensureCanMutate', () => {
    it('throws without auth', () => {
      const bareConfig: ConduitConfig = { network: 'testnet', factoryAddress: VALID_CONTRACT };
      const streams = new StreamsModule(bareConfig);
      expect(() => (streams as any)._ensureCanMutate()).toThrow(
        'keypair, wallet adapter, or signer is required for mutating operations',
      );
    });

    it('succeeds with keypair', () => {
      const streams = new StreamsModule(config);
      expect(() => (streams as any)._ensureCanMutate()).not.toThrow();
    });
  });

  describe('get() simulation failure', () => {
    it('throws on simulation error', async () => {
      mockSimulateTransaction.mockResolvedValue({ error: 'HostError: Error(Contract, #6)' });
      const streams = new StreamsModule(config);
      await expect(streams.get(1n)).rejects.toThrow();
    });
  });

  describe('list()', () => {
    it('returns empty when no sender/recipient', async () => {
      const streams = new StreamsModule(config);
      const result = await streams.list({});
      expect(result.streams).toHaveLength(0);
      expect(result.hasNextPage).toBe(false);
    });

    it('lists by sender', async () => {
      const streams = new StreamsModule(config);
      const result = await streams.list({ sender: 'GSENDER' });
      expect(result.streams).toHaveLength(3);
    });

    it('lists by recipient', async () => {
      const streams = new StreamsModule(config);
      const result = await streams.list({ recipient: 'GRECIP' });
      expect(result.streams).toHaveLength(2);
    });
  });

  describe('batchWithdraw', () => {
    it('reports per-item errors without throwing', async () => {
      const streams = new StreamsModule(config);
      vi.spyOn(streams, 'withdraw' as any)
        .mockRejectedValueOnce(new Error('Stream cancelled'))
        .mockResolvedValueOnce('txhash1');

      const results = await streams.batchWithdraw([
        { streamId: 1n },
        { streamId: 2n },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Stream cancelled');
      expect(results[1].success).toBe(true);
      expect(results[1].txHash).toBe('txhash1');
    });
  });

  describe('withdrawable', () => {
    it('returns the withdrawable amount', async () => {
      const streams = new StreamsModule(config);
      mockSimulateTransaction.mockResolvedValue({
        result: {
          retval: { toXDR: () => nativeToScVal(500n, { type: 'i128' }).toXDR() },
        },
      } as any);
      const amount = await streams.withdrawable(1n);
      expect(amount).toBe(500n);
    });
  });

  describe('list() — cursor/invalid', () => {
    it('throws on invalid cursor', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.list({ cursor: '!!!' })).rejects.toThrow('Invalid cursor');
    });

    it('throws on non-numeric cursor', async () => {
      const streams = new StreamsModule(config);
      const badCursor = Buffer.from('not_a_number', 'utf8').toString('base64');
      await expect(streams.list({ cursor: badCursor })).rejects.toThrow('Invalid cursor');
    });
  });

  describe('create — validation', () => {
    it('throws on invalid recipient', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: '',
        token: 'CAFEFACE',
        depositAmount: '100',
        ratePerSecond: '1',
      } as any)).rejects.toThrow('Invalid recipient address');
    });

    it('throws on invalid token', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: 'GRECIP',
        token: '',
        depositAmount: '100',
        ratePerSecond: '1',
      } as any)).rejects.toThrow('Invalid token address');
    });

    it('throws on invalid depositAmount', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: 'GRECIP',
        token: 'CAFEFACE',
        depositAmount: '',
        ratePerSecond: '1',
      } as any)).rejects.toThrow('Invalid deposit amount');
    });

    it('throws on invalid durationSeconds', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: 'GRECIP',
        token: 'CAFEFACE',
        depositAmount: '100',
        durationSeconds: 0,
      } as any)).rejects.toThrow('Invalid durationSeconds');
    });

    it('throws on invalid ratePerSecond', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: 'GRECIP',
        token: 'CAFEFACE',
        depositAmount: '100',
        ratePerSecond: '',
      } as any)).rejects.toThrow('Invalid ratePerSecond');
    });

    it('throws when neither duration nor rate provided', async () => {
      const streams = new StreamsModule(config);
      await expect(streams.create({
        recipient: 'GRECIP',
        token: 'CAFEFACE',
        depositAmount: '100',
      } as any)).rejects.toThrow('durationSeconds or ratePerSecond');
    });
  });

  describe('_signer returns null', () => {
    it('returns null when no signer configured', () => {
      const streams = new StreamsModule(config);
      expect((streams as any)._signer()).toBeNull();
    });
  });

  describe('_getSenderAddress', () => {
    it('returns signer publicKey when no wallet', async () => {
      const { StrKey, Keypair } = await import('@stellar/stellar-sdk');
      const buf = Buffer.alloc(32);
      require('crypto').randomFillSync(buf);
      const contractId = StrKey.encodeContract(buf);
      const signerPk = Keypair.random().publicKey();
      const streams = new StreamsModule({
        network: 'testnet',
        factoryAddress: contractId,
        signer: { sign: vi.fn(), publicKey: () => signerPk },
      } as any);
      (streams as any).activeWallet = undefined;
      const addr = await (streams as any)._getSenderAddress();
      expect(addr).toBe(signerPk);
    });

    it('returns keypair publicKey when no wallet or signer', async () => {
      const { StrKey, Keypair } = await import('@stellar/stellar-sdk');
      const buf = Buffer.alloc(32);
      require('crypto').randomFillSync(buf);
      const contractId = StrKey.encodeContract(buf);
      const kp = Keypair.random();
      const streams = new StreamsModule({
        network: 'testnet',
        factoryAddress: contractId,
        keypair: kp,
      } as any);
      (streams as any).activeWallet = undefined;
      const addr = await (streams as any)._getSenderAddress();
      expect(addr).toBe(kp.publicKey());
    });
  });

  describe('_signTx with keypair', () => {
    it('signs with keypair when no wallet or signer', async () => {
      const { StrKey, Keypair, Transaction } = await import('@stellar/stellar-sdk');
      const buf = Buffer.alloc(32);
      require('crypto').randomFillSync(buf);
      const contractId = StrKey.encodeContract(buf);
      const kp = Keypair.random();
      const streams = new StreamsModule({
        network: 'testnet',
        factoryAddress: contractId,
        keypair: kp,
      } as any);
      (streams as any).activeWallet = undefined;
      const mockTx = { sign: vi.fn(), toXDR: () => '' } as any;
      const result = await (streams as any)._signTx(mockTx);
      expect(mockTx.sign).toHaveBeenCalledWith(kp);
      expect(result).toBe(mockTx);
    });
  });
});
