import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrKey, Keypair } from '@stellar/stellar-sdk';
import { StreamBuilder, ConduitBatcher } from '../builder.js';

const VALID_TOKEN = (() => {
  const buf = Buffer.alloc(32);
  require('crypto').randomFillSync(buf);
  return StrKey.encodeContract(buf);
})();

const VALID_SENDER = Keypair.random().publicKey();
const VALID_RECIP = Keypair.random().publicKey();

describe('StreamBuilder — advanced scenarios', () => {
  describe('destroy lifecycle', () => {
    it('throws on build after destroy', () => {
      const builder = new StreamBuilder();
      builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
      builder.cleanup();
      expect(() => builder.build()).toThrow('StreamBuilder has been destroyed');
    });

    it('throws on submit after destroy', async () => {
      const builder = new StreamBuilder();
      builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
      builder.cleanup();
      await expect(builder.submit(vi.fn())).rejects.toThrow('StreamBuilder has been destroyed');
    });
  });

  describe('ratePerSecond validation', () => {
    it('rejects zero bigint rate', () => {
      expect(() => new StreamBuilder().ratePerSecond(0n)).toThrow('must be a positive value');
    });

    it('rejects negative bigint rate', () => {
      expect(() => new StreamBuilder().ratePerSecond(-1n)).toThrow('must be a positive value');
    });

    it('rejects zero number rate', () => {
      expect(() => new StreamBuilder().ratePerSecond(0)).toThrow('must be a positive finite number');
    });

    it('rejects negative number rate', () => {
      expect(() => new StreamBuilder().ratePerSecond(-1)).toThrow('must be a positive finite number');
    });

    it('rejects NaN rate', () => {
      expect(() => new StreamBuilder().ratePerSecond(NaN)).toThrow('must be a positive finite number');
    });
  });

  describe('amount validation', () => {
    it('rejects zero amount', () => {
      expect(() => new StreamBuilder().amount(0)).toThrow('amount must be a positive finite number');
    });

    it('rejects negative amount', () => {
      expect(() => new StreamBuilder().amount(-100)).toThrow('amount must be a positive finite number');
    });
  });

  describe('address validation', () => {
    it('rejects empty token', () => {
      expect(() => new StreamBuilder().token('')).toThrow('must be a non-empty string');
    });

    it('rejects empty sender', () => {
      expect(() => new StreamBuilder().sender('')).toThrow('must be a non-empty string');
    });

    it('rejects whitespace-only recipient', () => {
      expect(() => new StreamBuilder().recipient('   ')).toThrow('must be a non-empty string');
    });

    it('rejects G-address as token', () => {
      expect(() => new StreamBuilder().token(VALID_SENDER)).toThrow('valid Soroban contract ID');
    });

    it('rejects invalid sender', () => {
      expect(() => new StreamBuilder().sender('NOTVALID')).toThrow('valid Stellar public key');
    });
  });

  describe('submit() with abort signal', () => {
    it('throws AbortError when signal is already aborted', async () => {
      const builder = new StreamBuilder();
      builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
      const controller = new AbortController();
      controller.abort();
      await expect(
        builder.submit(vi.fn(), { signal: controller.signal }),
      ).rejects.toThrow('Aborted');
    });

    it('throws when submitFn is not a function', async () => {
      const builder = new StreamBuilder();
      builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
      await expect(builder.submit(null as any)).rejects.toThrow('submitFn must be a valid function');
    });
  });
});

describe('ConduitBatcher — advanced scenarios', () => {
  const validItem = { token: VALID_TOKEN, sender: VALID_SENDER, recipient: VALID_RECIP, amount: 100 };

  describe('validatePayload', () => {
    it('rejects null payload', () => {
      const result = ConduitBatcher.execute(null as any);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Batch payload cannot be null or undefined');
    });

    it('rejects non-array payload', () => {
      const result = ConduitBatcher.execute({} as any);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Batch payload must be an array');
    });

    it('rejects non-object items', () => {
      const result = ConduitBatcher.execute(['string' as any]);
      expect(result.success).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('rejects null items', () => {
      const result = ConduitBatcher.execute([null as any]);
      expect(result.success).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('validates token address format', () => {
      const result = ConduitBatcher.execute([{ ...validItem, token: 'INVALID' }]);
      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('token must be a valid Soroban contract ID');
    });

    it('validates sender address format', () => {
      const result = ConduitBatcher.execute([{ ...validItem, sender: 'INVALID' }]);
      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('sender must be a valid Stellar public key');
    });

    it('validates zero amount', () => {
      const result = ConduitBatcher.execute([{ ...validItem, amount: 0 }]);
      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('amount must be a positive finite number');
    });

    it('validates negative amount', () => {
      const result = ConduitBatcher.execute([{ ...validItem, amount: -1 }]);
      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('amount must be a positive finite number');
    });
  });

  describe('chunking', () => {
    it('returns 0 chunks for empty array', () => {
      const result = ConduitBatcher.execute([]);
      expect(result.success).toBe(true);
      expect(result.chunks).toBe(0);
    });

    it('chunks correctly with default maxBatchSize', () => {
      const streams = Array.from({ length: 120 }, () => validItem);
      const result = ConduitBatcher.execute(streams);
      expect(result.success).toBe(true);
      expect(result.chunks).toBe(3);
    });

    it('respects custom maxBatchSize', () => {
      const streams = Array.from({ length: 10 }, () => validItem);
      const result = ConduitBatcher.execute(streams, { maxBatchSize: 3 });
      expect(result.success).toBe(true);
      expect(result.chunks).toBe(4);
    });
  });

  describe('destroy and reset lifecycle', () => {
    afterEach(() => {
      ConduitBatcher.reset();
    });

    it('throws after destroy', () => {
      ConduitBatcher.destroy();
      expect(() => ConduitBatcher.execute([validItem])).toThrow('ConduitBatcher has been destroyed');
    });

    it('works again after reset', () => {
      ConduitBatcher.destroy();
      ConduitBatcher.reset();
      expect(ConduitBatcher.execute([validItem]).success).toBe(true);
    });

    it('aborts before processing when signal is pre-aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const result = await ConduitBatcher.executeAsync(
        [{ operation: 'create_stream', params: {} }],
        ac.signal,
      );
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Operation aborted');
    });

    it('handles non-aborted signal by processing normally', async () => {
      const ac = new AbortController();
      const result = await ConduitBatcher.executeAsync(
        [{ operation: 'create_stream', params: {} }],
        ac.signal,
      );
      expect(result.success).toBe(true);
    });
  });
});

describe('StreamBuilder — submit retry exhaustion', () => {
  it('throws after all retries exhausted', async () => {
    const builder = new StreamBuilder();
    builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
    await expect(
      builder.submit(
        async () => { throw new Error('fail'); },
        { maxRetries: 0, retryDelayMs: 1 },
      ),
    ).rejects.toThrow('retries');
  });

  it('aborts after retry exhausted in submit', async () => {
    const builder = new StreamBuilder();
    builder.token(VALID_TOKEN).sender(VALID_SENDER).recipient(VALID_RECIP).amount(100);
    const ac = new AbortController();
    const submitPromise = builder.submit(
      async () => {
        ac.abort();
        throw new Error('fail');
      },
      { signal: ac.signal, maxRetries: 1, retryDelayMs: 4 },
    );
    await expect(submitPromise).rejects.toThrow();
  });
});
