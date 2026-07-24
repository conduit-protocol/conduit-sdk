import { describe, expect, it } from 'vitest';
import { NonceManager } from '../nonce-manager.js';

describe('NonceManager', () => {
  it('serializes rapid concurrent requests and returns unique nonces', async () => {
    const manager = new NonceManager(0);

    const fetcher = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 0;
    };

    const promises = Array.from({ length: 150 }, () => manager.getNextNonce(fetcher));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(150);
    expect(new Set(results).size).toBe(150);
    expect(results.every((nonce, index) => nonce === index + 1)).toBe(true);
    expect(manager.getCurrentNonce()).toBe(150);
  });

  it('uses a higher network nonce when it is ahead of the local counter', async () => {
    const manager = new NonceManager(10);

    const nonce1 = await manager.getNextNonce(async () => 20.99999);
    expect(nonce1).toBe(20);

    const nonce2 = await manager.getNextNonce(async () => 10);
    expect(nonce2).toBe(21);
  });

  it('falls back to the local counter when the network call fails', async () => {
    const manager = new NonceManager(5);
    let attempt = 0;

    const nonce1 = await manager.getNextNonce(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('temporary failure');
      }
      return 7;
    });

    expect(nonce1).toBe(6);

    const nonce2 = await manager.getNextNonce(async () => 7);
    expect(nonce2).toBe(7);
  });
});
