import { describe, expect, it } from 'vitest';

describe('NonceManager public export', () => {
  it('is exported from the package entry point as the bigint-based implementation', async () => {
    const { NonceManager } = await import('../index.js');

    const manager = new NonceManager({ startNonce: 0n, maxNonce: 10n });
    const lock = await manager.acquire();

    // The bigint-based `src/nonce/NonceManager.ts` implementation hands out
    // `bigint` nonces; the removed number-based `src/nonce-manager.ts`
    // duplicate could not represent Stellar int64 sequence numbers above 2^53
    // and exposed no `acquire()`/`release()` API.
    expect(typeof lock.nonce).toBe('bigint');
    expect(lock.nonce).toBe(0n);

    lock.release();
    manager.destroy();
  });
});
