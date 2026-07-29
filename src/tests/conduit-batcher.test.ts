import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConduitBatcher, StreamBuilder, type BatchOperation } from '../builder.js';

describe('ConduitBatcher', () => {
  beforeEach(() => {
    ConduitBatcher.reset();
  });

  describe('execute — payload validation', () => {
    it('returns error result for null payload', () => {
      const result = ConduitBatcher.execute(null as unknown as Record<string, unknown>[]);

      expect(result.success).toBe(false);
      expect(result.operations).toBe(0);
      expect(result.xdr).toBe('');
      expect(result.errors).toContain('Batch payload cannot be null or undefined');
    });

    it('returns error result for undefined payload', () => {
      const result = ConduitBatcher.execute(undefined as unknown as Record<string, unknown>[]);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Batch payload cannot be null or undefined');
    });

    it('returns error result for non-array payload', () => {
      expect(ConduitBatcher.execute({} as unknown as Record<string, unknown>[]).errors).toContain(
        'Batch payload must be an array',
      );
      expect(ConduitBatcher.execute(123 as unknown as Record<string, unknown>[]).success).toBe(false);
      expect(ConduitBatcher.execute('bad' as unknown as Record<string, unknown>[]).success).toBe(false);
      expect(ConduitBatcher.execute(true as unknown as Record<string, unknown>[]).success).toBe(false);
    });

    it('returns error result for array containing null items', () => {
      const result = ConduitBatcher.execute([null as unknown as Record<string, unknown>]);

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('returns error result for array containing undefined items', () => {
      const result = ConduitBatcher.execute([undefined as unknown as Record<string, unknown>]);

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('returns error result for array containing non-object items', () => {
      const result = ConduitBatcher.execute(['string' as unknown as Record<string, unknown>]);

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('must be an object');
    });

    it('reports validation errors for the first invalid item index', () => {
      const valid = { token: 'CD1' };
      const result = ConduitBatcher.execute([
        valid,
        null as unknown as Record<string, unknown>,
        'bad' as unknown as Record<string, unknown>,
      ]);

      expect(result.success).toBe(false);
      expect(result.errors!.some(e => e.includes('index 1'))).toBe(true);
    });

    it('accepts an empty array as a valid no-op batch', () => {
      const result = ConduitBatcher.execute([]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(0);
      expect(result.chunks).toBe(0);
      expect(result.xdr).toBe('AAAA...mock...batch...XDR');
      expect(result.errors).toBeUndefined();
    });
  });

  describe('execute — successful batch compilation', () => {
    it('executes a batch of StreamBuilder outputs', () => {
      const stream1 = new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(100)
        .build();

      const stream2 = new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(200)
        .build();

      const result = ConduitBatcher.execute([stream1, stream2]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(2);
      expect(result.chunks).toBe(1);
      expect(result.xdr).toBe('AAAA...mock...batch...XDR');
    });

    it('returns the correct operation count for arbitrary record payloads', () => {
      const result = ConduitBatcher.execute([
        { method: 'create', params: { token: 'CD1' } },
        { method: 'withdraw', params: { streamId: 1n } },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(2);
    });

    it('handles a single-item batch', () => {
      const result = ConduitBatcher.execute([{ token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', amount: 100 }]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
      expect(result.chunks).toBe(1);
    });
  });

  describe('execute — bigint serialization', () => {
    it('accepts payloads with top-level bigint fields', () => {
      const result = ConduitBatcher.execute([
        {
          token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
          sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
          recipient: 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA',
          rate: BigInt('9007199254740993'),
          deposit: 50000n,
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts deeply nested bigint values', () => {
      const result = ConduitBatcher.execute([
        {
          id: 1,
          metadata: { nested: { value: 9007199254740993n } },
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts mixed bigint and primitive fields', () => {
      const result = ConduitBatcher.execute([
        { id: 1n, rate: 2n, name: 'stream-a' },
        { id: 3, rate: 4, name: 'stream-b' },
        { nested: { deep: { val: 99n } } },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(3);
    });

    it('accepts payloads with null nested values alongside bigints', () => {
      const result = ConduitBatcher.execute([
        { a: 1n, b: 'hello', c: true, d: null, e: { f: 2n } },
      ] as Record<string, unknown>[]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts payloads containing symbols without throwing', () => {
      const sym = Symbol('test');
      const result = ConduitBatcher.execute([
        { key: sym as unknown as string, token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });
  });

  describe('execute — chunking', () => {
    it('uses a single chunk when batch size is within the default limit', () => {
      const streams = Array.from({ length: 2 }, (_, i) => ({ id: i, name: `stream-${i}` }));
      const result = ConduitBatcher.execute(streams);

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(2);
    });

    it('uses the default batch size of 50', () => {
      const streams = Array.from({ length: 55 }, (_, i) => ({
        id: BigInt(i),
        name: `stream-${i}`,
      }));

      const result = ConduitBatcher.execute(streams);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(55);
      expect(result.chunks).toBe(2);
    });

    it('respects a custom maxBatchSize option', () => {
      const streams = Array.from({ length: 120 }, (_, i) => ({
        id: BigInt(i),
        name: `stream-${i}`,
      }));

      const result = ConduitBatcher.execute(streams, { maxBatchSize: 50 });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(120);
      expect(result.chunks).toBe(3);
    });

    it('creates one chunk per item when maxBatchSize is 1', () => {
      const streams = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const result = ConduitBatcher.execute(streams, { maxBatchSize: 1 });

      expect(result.chunks).toBe(3);
      expect(result.operations).toBe(3);
    });

    it('creates a single chunk when maxBatchSize exceeds the payload length', () => {
      const streams = [{ id: 1 }, { id: 2 }];
      const result = ConduitBatcher.execute(streams, { maxBatchSize: 100 });

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(2);
    });

    it('creates exactly one chunk when length equals maxBatchSize', () => {
      const streams = Array.from({ length: 50 }, (_, i) => ({ id: i }));
      const result = ConduitBatcher.execute(streams, { maxBatchSize: 50 });

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(50);
    });
  });

  describe('execute — destroyed state', () => {
    it('throws when execute is called after destroy', () => {
      ConduitBatcher.destroy();

      expect(() => ConduitBatcher.execute([{ token: 'CD1' }])).toThrow(
        'ConduitBatcher has been destroyed',
      );
    });
  });

  describe('executeAsync', () => {
    it('resolves successfully with valid operations', async () => {
      const result = await ConduitBatcher.executeAsync([
        { method: 'create', params: { token: 'CD1', amount: 100n } },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
      expect(result.xdr).toBe('AAAA...mock...batch...XDR');
    });

    it('returns error result for null operations', async () => {
      const result = await ConduitBatcher.executeAsync(null as unknown as BatchOperation[]);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('returns error result for invalid operation items', async () => {
      const result = await ConduitBatcher.executeAsync([
        null as unknown as BatchOperation,
      ]);

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('accepts an abort signal and returns a cancellation error', async () => {
      const ac = new AbortController();
      ac.abort();

      const result = await ConduitBatcher.executeAsync(
        [{ method: 'create', params: { token: 'CD1' } }],
        ac.signal,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Operation aborted');
    });

    it('rejects when called after destroy', async () => {
      ConduitBatcher.destroy();

      await expect(
        ConduitBatcher.executeAsync([{ method: 'create', params: { token: 'CD1' } }]),
      ).rejects.toThrow('ConduitBatcher has been destroyed');
    });

    it('processes multiple queued executeAsync calls', async () => {
      const results = await Promise.all([
        ConduitBatcher.executeAsync([{ method: 'op1', params: { id: 1 } }]),
        ConduitBatcher.executeAsync([{ method: 'op2', params: { id: 2 } }]),
        ConduitBatcher.executeAsync([{ method: 'op3', params: { id: 3 } }]),
      ]);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.operations).toBe(1);
      }
    });

    it('handles rapid concurrent executeAsync calls without error', async () => {
      const promises = Array.from({ length: 50 }, (_, i) =>
        ConduitBatcher.executeAsync([{ method: 'rapid', params: { index: i } }]),
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(50);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.operations).toBe(1);
      }
    });

    it('sanitizes bigint values inside operation params', async () => {
      const result = await ConduitBatcher.executeAsync([
        { method: 'topUp', params: { streamId: 1n, amount: 9007199254740993n } },
      ]);

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });
  });

  describe('cleanup, destroy, and reset', () => {
    it('cleanup resolves pending executeAsync calls with an error', async () => {
      const processQueueSpy = vi
        .spyOn(ConduitBatcher as unknown as { processQueue: () => Promise<void> }, 'processQueue')
        .mockImplementation(() => Promise.resolve());

      const pending = ConduitBatcher.executeAsync([
        { method: 'create', params: { token: 'CD1' } },
      ]);

      ConduitBatcher.cleanup();
      processQueueSpy.mockRestore();

      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errors).toContain('ConduitBatcher cleaned up');
    });

    it('reset clears the destroyed flag so execute works again', () => {
      ConduitBatcher.destroy();
      ConduitBatcher.reset();

      const result = ConduitBatcher.execute([{ token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' }]);
      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('reset clears the destroyed flag so executeAsync works again', async () => {
      ConduitBatcher.destroy();
      ConduitBatcher.reset();

      const result = await ConduitBatcher.executeAsync([
        { method: 'create', params: { token: 'CD1' } },
      ]);
      expect(result.success).toBe(true);
    });
  });
});
