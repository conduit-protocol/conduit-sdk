/**
 * Regression tests: ConduitBatcher must build genuine transaction XDR, never a
 * placeholder string.
 *
 * The bug: execute/executeAsync/processQueue returned
 * `xdr: 'AAAA...mock...batch...XDR'` alongside `success: true`, so a consumer
 * got a fake success and an unsubmittable string with no indication anything
 * was wrong until submission.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, Networks, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { ConduitBatcher } from '../builder.js';
import {
  BatchBuildError,
  buildBatchTransactionsSync,
  operationToScVals,
  paramToScVal,
  validateContext,
  type BatchTransactionContext,
} from '../batch-tx.js';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

const CONTEXT: BatchTransactionContext = {
  contractId: CONTRACT_ID,
  sourceAccount: SOURCE,
  network: 'testnet',
  sequence: '100',
};

/** Decode an envelope; a placeholder string cannot survive this. */
function decode(envelope: string, passphrase: string = Networks.TESTNET): Transaction {
  const tx = TransactionBuilder.fromXDR(envelope, passphrase);
  if (!(tx instanceof Transaction)) {
    throw new Error('Expected a plain transaction, got a fee-bump transaction');
  }
  return tx;
}

describe('ConduitBatcher builds real XDR', () => {
  let batcher: ConduitBatcher;

  beforeEach(() => {
    batcher = new ConduitBatcher();
  });

  describe('the placeholder is gone', () => {
    it('never returns the mock XDR string', () => {
      const result = batcher.execute(
        [{ token: CONTRACT_ID, sender: SOURCE, recipient: RECIPIENT, amount: 100 }],
        { context: CONTEXT },
      );

      expect(result.success).toBe(true);
      expect(result.xdr).not.toContain('mock');
      expect(result.xdr.length).toBeGreaterThan(64);
    });

    it('produces XDR that round-trips through the real codec', () => {
      const result = batcher.execute(
        [{ token: CONTRACT_ID, amount: 100 }],
        { context: CONTEXT },
      );

      const tx = decode(result.xdr);
      expect(tx.toXDR()).toBe(result.xdr);
      expect(tx.source).toBe(SOURCE);
      expect(tx.networkPassphrase).toBe(Networks.TESTNET);
    });

    it('rejects the old placeholder as undecodable, proving the check has teeth', () => {
      expect(() => decode('AAAA...mock...batch...XDR')).toThrow();
    });
  });

  describe('one transaction per operation', () => {
    // Soroban allows a single InvokeHostFunction operation per transaction, so
    // N batched operations must produce N transactions.
    it('returns one XDR per operation', () => {
      const streams = Array.from({ length: 4 }, (_, i) => ({ token: CONTRACT_ID, amount: i + 1 }));
      const result = batcher.execute(streams, { context: CONTEXT });

      expect(result.operations).toBe(4);
      expect(result.xdrs).toHaveLength(4);
      for (const envelope of result.xdrs!) {
        expect(decode(envelope).operations).toHaveLength(1);
      }
    });

    it('assigns consecutive sequence numbers so the batch submits in order', () => {
      const streams = [{ amount: 1 }, { amount: 2 }, { amount: 3 }];
      const result = batcher.execute(streams, { context: CONTEXT });

      const sequences = result.xdrs!.map(e => decode(e).sequence);
      expect(sequences).toEqual(['101', '102', '103']);
    });

    it('reports the source operation index and method per transaction', () => {
      const result = batcher.execute([{ amount: 1 }, { amount: 2 }], {
        context: CONTEXT,
        method: 'create_stream',
      });

      expect(result.transactions).toEqual([
        expect.objectContaining({ index: 0, method: 'create_stream', prepared: false }),
        expect.objectContaining({ index: 1, method: 'create_stream', prepared: false }),
      ]);
    });

    it('marks offline-built transactions as not yet prepared', () => {
      const result = batcher.execute([{ amount: 1 }], { context: CONTEXT });
      expect(result.prepared).toBe(false);
    });
  });

  describe('missing context fails loudly instead of faking success', () => {
    it('fails when no context is supplied', () => {
      const result = batcher.execute([{ amount: 1 }]);

      expect(result.success).toBe(false);
      expect(result.xdr).toBe('');
      expect(result.errors![0]).toContain('BatchTransactionContext');
    });

    it('still reports chunking so the caller can see the batch was understood', () => {
      const streams = Array.from({ length: 60 }, (_, i) => ({ amount: i + 1 }));
      const result = batcher.execute(streams);

      expect(result.success).toBe(false);
      expect(result.chunks).toBe(2);
    });

    it('fails when the sync path is given only an rpcUrl', () => {
      const result = batcher.execute([{ amount: 1 }], {
        context: {
          contractId: CONTRACT_ID,
          sourceAccount: SOURCE,
          network: 'testnet',
          rpcUrl: 'https://soroban-testnet.stellar.org',
        },
      });

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('executeAsync');
    });

    it.each([
      ['a bad contractId', { ...CONTEXT, contractId: 'not-a-contract' }, 'contractId'],
      ['a bad sourceAccount', { ...CONTEXT, sourceAccount: 'nope' }, 'sourceAccount'],
      ['a non-numeric sequence', { ...CONTEXT, sequence: 'abc' }, 'sequence'],
    ])('rejects %s', (_label, context, expected) => {
      const result = batcher.execute([{ amount: 1 }], {
        context: context as BatchTransactionContext,
      });

      expect(result.success).toBe(false);
      expect(result.errors!.join(' ')).toContain(expected);
    });

    it('rejects a context with neither network nor passphrase', () => {
      const errors = validateContext({
        contractId: CONTRACT_ID,
        sourceAccount: SOURCE,
        sequence: '1',
      });
      expect(errors.join(' ')).toContain('networkPassphrase');
    });

    it('accepts an explicit passphrase in place of a named network', () => {
      const result = batcher.execute([{ amount: 1 }], {
        context: {
          contractId: CONTRACT_ID,
          sourceAccount: SOURCE,
          networkPassphrase: Networks.PUBLIC,
          sequence: '7',
        },
      });

      expect(result.success).toBe(true);
      expect(decode(result.xdr, Networks.PUBLIC).sequence).toBe('8');
    });
  });

  describe('empty batches', () => {
    it('is a valid no-op needing no context', () => {
      const result = batcher.execute([]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(0);
      expect(result.xdrs).toEqual([]);
      expect(result.xdr).toBe('');
      expect(result.errors).toBeUndefined();
    });
  });

  describe('executeAsync', () => {
    it('builds real XDR when given a context', async () => {
      const result = await batcher.executeAsync(
        [{ method: 'withdraw', params: { streamId: 1n } }],
        { context: CONTEXT },
      );

      expect(result.success).toBe(true);
      expect(result.xdr).not.toContain('mock');
      expect(decode(result.xdr).operations).toHaveLength(1);
    });

    it('fails without a context rather than returning a placeholder', async () => {
      const result = await batcher.executeAsync([
        { method: 'withdraw', params: { streamId: 1n } },
      ]);

      expect(result.success).toBe(false);
      expect(result.xdr).toBe('');
      expect(result.errors![0]).toContain('BatchTransactionContext');
    });

    it('still accepts the original (operations, signal) call shape', async () => {
      const ac = new AbortController();
      ac.abort();

      const result = await batcher.executeAsync(
        [{ method: 'withdraw', params: { streamId: 1n } }],
        ac.signal,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Operation aborted');
    });

    it('builds one transaction per queued operation', async () => {
      const result = await batcher.executeAsync(
        [
          { method: 'withdraw', params: { streamId: 1n } },
          { method: 'cancel', params: { streamId: 2n } },
        ],
        { context: CONTEXT },
      );

      expect(result.xdrs).toHaveLength(2);
      expect(result.transactions!.map(t => t.method)).toEqual(['withdraw', 'cancel']);
    });
  });

  describe('parameter encoding', () => {
    it('encodes Stellar addresses as Address values, not strings', () => {
      const scVal = paramToScVal(SOURCE);
      expect(scVal.switch().name).toBe('scvAddress');
    });

    it('encodes contract IDs as Address values', () => {
      expect(paramToScVal(CONTRACT_ID).switch().name).toBe('scvAddress');
    });

    it('encodes bigints as i128', () => {
      expect(paramToScVal(42n).switch().name).toBe('scvI128');
    });

    it('maps values with no ScVal representation to void instead of throwing', () => {
      for (const value of [undefined, null, Symbol('x'), () => {}]) {
        expect(paramToScVal(value).switch().name).toBe('scvVoid');
      }
    });

    it('passes positional args verbatim when supplied', () => {
      const args = operationToScVals({ args: [1n, SOURCE], params: { ignored: true } });
      expect(args).toHaveLength(2);
      expect(args[0]!.switch().name).toBe('scvI128');
      expect(args[1]!.switch().name).toBe('scvAddress');
    });

    it('passes params as a single sorted map when no args are given', () => {
      const args = operationToScVals({ params: { zeta: 1, alpha: 2 } });

      expect(args).toHaveLength(1);
      expect(args[0]!.switch().name).toBe('scvMap');

      const keys = args[0]!.map()!.map((entry: xdr.ScMapEntry) => entry.key().sym().toString());
      expect(keys).toEqual(['alpha', 'zeta']);
    });

    it('sends no arguments for an operation with empty params', () => {
      expect(operationToScVals({ params: {} })).toEqual([]);
    });
  });

  describe('buildBatchTransactionsSync', () => {
    it('throws a named error when the context is invalid', () => {
      expect(() =>
        buildBatchTransactionsSync([{ method: 'x' }], {
          contractId: 'bad',
          sourceAccount: SOURCE,
          network: 'testnet',
          sequence: '1',
        }),
      ).toThrow(BatchBuildError);
    });

    it('throws when an operation has no method name', () => {
      expect(() =>
        buildBatchTransactionsSync([{ method: '' }], CONTEXT),
      ).toThrow(/missing a method name/);
    });

    it('builds against a randomly generated account', () => {
      const account = Keypair.random().publicKey();
      const [built] = buildBatchTransactionsSync([{ method: 'ping' }], {
        ...CONTEXT,
        sourceAccount: account,
      });

      expect(decode(built!.xdr).source).toBe(account);
    });
  });
});
