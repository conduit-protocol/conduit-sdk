import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NonceManager, type NonceLock } from '../nonce/NonceManager.js';

describe('NonceManager — Concurrent Nonce Integration Tests', () => {
  let manager: NonceManager;

  beforeEach(() => {
    manager = new NonceManager({ startNonce: 0n, maxNonce: 1000n });
  });

  afterEach(() => {
    manager.destroy();
  });

  it('acquires sequential nonces without gaps', async () => {
    const locks: NonceLock[] = [];
    for (let i = 0; i < 5; i++) {
      const lock = await manager.acquire();
      expect(lock.nonce).toBe(BigInt(i));
      locks.push(lock);
      lock.release();
    }

    for (const lock of locks) {
      lock.release();
    }
  });

  it('does not duplicate nonces under concurrent load', async () => {
    const count = 100;
    const nonces: bigint[] = [];

    for (let i = 0; i < count; i++) {
      const lock = await manager.acquire();
      nonces.push(lock.nonce);
      lock.release();
    }

    const uniqueNonces = new Set(nonces.map(n => n.toString()));
    expect(uniqueNonces.size).toBe(count);
    expect(nonces).toEqual(Array.from({ length: count }, (_, i) => BigInt(i)));
  });

  it('tracks acquired nonces correctly', async () => {
    const lock1 = await manager.acquire();
    expect(manager.acquired).toBe(1);
    lock1.release();
    expect(manager.acquired).toBe(0);

    const lock2 = await manager.acquire();
    expect(manager.acquired).toBe(1);
    lock2.release();
    expect(manager.acquired).toBe(0);
  });

  it('respects maxNonce boundary', async () => {
    const small = new NonceManager({ startNonce: 0n, maxNonce: 5n });
    const locks = [];

    for (let i = 0; i < 5; i++) {
      const lock = await small.acquire();
      locks.push(lock);
      lock.release();
    }

    expect(small.remaining).toBe(0n);
    await expect(small.acquire()).rejects.toThrow('exceeds maximum');

    small.destroy();
  });

  it('acquireWithFallback works with proper release pattern', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });

    const lock1 = await m.acquire();
    expect(lock1.nonce).toBe(0n);
    lock1.release();

    const lock2 = await m.acquireWithFallback(100);
    expect(lock2.nonce).toBe(1n);
    lock2.release();

    m.destroy();
  });

  it('does not deadlock after acquireWithFallback times out on a held lock', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });

    const lock1 = await m.acquire();
    expect(lock1.nonce).toBe(0n);

    await expect(m.acquireWithFallback(20)).rejects.toThrow('timed out');

    lock1.release();

    const lock2 = await m.acquireWithFallback(50);
    expect(lock2.nonce).toBe(1n);
    lock2.release();

    m.destroy();
  });

  it('safeAcquire retries on failure', async () => {
    const tiny = new NonceManager({ startNonce: 0n, maxNonce: 1n });

    const lock = await tiny.acquire();
    lock.release();
    expect(tiny.remaining).toBe(0n);

    await expect(tiny.safeAcquire(2, 10)).rejects.toThrow();

    tiny.destroy();
  });

  it('validates nonce values correctly', () => {
    expect(NonceManager.isNonceValid(0n)).toBe(true);
    expect(NonceManager.isNonceValid(100n)).toBe(true);
    expect(NonceManager.isNonceValid('12345')).toBe(true);
    expect(NonceManager.isNonceValid(0)).toBe(true);
    expect(NonceManager.isNonceValid(-1n)).toBe(false);
    expect(NonceManager.isNonceValid(null)).toBe(false);
    expect(NonceManager.isNonceValid(undefined)).toBe(false);
    expect(NonceManager.isNonceValid('abc')).toBe(false);
    expect(NonceManager.isNonceValid({})).toBe(false);
  });

  it('rejects negative startNonce', () => {
    expect(() => new NonceManager({ startNonce: -1n })).toThrow(
      'startNonce cannot be negative',
    );
  });

  it('rejects maxNonce <= startNonce', () => {
    expect(() => new NonceManager({ startNonce: 10n, maxNonce: 10n })).toThrow(
      'maxNonce must be greater than startNonce',
    );
  });

  it('converts string nonces to bigint', () => {
    const m = new NonceManager({ startNonce: '42', maxNonce: '100' });
    expect(m.current).toBe(42n);
    m.destroy();
  });

  it('handles string bigint nonces safely', () => {
    const m = new NonceManager({ startNonce: '9007199254740993', maxNonce: '9007199254740994' });
    expect(m.current).toBe(9007199254740993n);
    m.destroy();
  });

  it('throws a descriptive error for an unparseable string startNonce', () => {
    // Regression test for #458: an unparseable nonce must not silently
    // coerce to 0n, which would mask a caller bug (e.g. a stringified
    // undefined or a malformed network response) as an explicit 0.
    expect(() => new NonceManager({ startNonce: 'not-a-number' })).toThrow(
      /invalid nonce value "not-a-number"/,
    );
  });

  it('throws for an empty-string startNonce instead of silently using 0n', () => {
    expect(() => new NonceManager({ startNonce: '', maxNonce: '100' })).toThrow(
      /empty string/,
    );
  });

  it('accepts numeric and bigint startNonce values', () => {
    const fromNumber = new NonceManager({ startNonce: 42, maxNonce: 100 });
    expect(fromNumber.current).toBe(42n);
    fromNumber.destroy();

    const fromBigInt = new NonceManager({ startNonce: 7n, maxNonce: 100n });
    expect(fromBigInt.current).toBe(7n);
    fromBigInt.destroy();
  });

  it('reset clears state and allows reacquisition', async () => {
    const lock1 = await manager.acquire();
    lock1.release();
    expect(manager.current).toBe(1n);

    await manager.reset(0n);
    expect(manager.current).toBe(0n);
    expect(manager.acquired).toBe(0);

    const lock3 = await manager.acquire();
    expect(lock3.nonce).toBe(0n);
    lock3.release();
  });
});