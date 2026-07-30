import { describe, it, expect, beforeEach } from 'vitest';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { getServer, clearServerCache } from '../soroban.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAINNET_RPC = 'https://soroban-mainnet.stellar.org';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const LOCAL_RPC   = 'http://localhost:8000/soroban/rpc';

// ---------------------------------------------------------------------------
// getServer - cache behaviour
// ---------------------------------------------------------------------------

describe('getServer', () => {
  beforeEach(() => {
    clearServerCache();
  });

  it('returns a SorobanRpc.Server instance', () => {
    const server = getServer(MAINNET_RPC);
    expect(server).toBeInstanceOf(SorobanRpc.Server);
  });

  it('returns the same instance for the same URL on repeated calls', () => {
    const a = getServer(MAINNET_RPC);
    const b = getServer(MAINNET_RPC);
    const c = getServer(MAINNET_RPC);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns different instances for different URLs', () => {
    const mainnet = getServer(MAINNET_RPC);
    const testnet = getServer(TESTNET_RPC);
    const local   = getServer(LOCAL_RPC);

    expect(mainnet).not.toBe(testnet);
    expect(testnet).not.toBe(local);
    expect(local).not.toBe(mainnet);
  });

  it('preserves identity after interleaved calls with different URLs', () => {
    const a1 = getServer(MAINNET_RPC);
    const b1 = getServer(TESTNET_RPC);
    const a2 = getServer(MAINNET_RPC);
    const b2 = getServer(TESTNET_RPC);
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });

  it('handles trailing-slash URL variants independently (exact string match)', () => {
    const withoutSlash = getServer('https://rpc.example.com');
    const withSlash    = getServer('https://rpc.example.com/');
    expect(withoutSlash).not.toBe(withSlash);
  });
});

// ---------------------------------------------------------------------------
// clearServerCache
// ---------------------------------------------------------------------------

describe('clearServerCache', () => {
  beforeEach(() => {
    clearServerCache();
  });

  it('invalidates all cached server instances', () => {
    const before = getServer(MAINNET_RPC);
    clearServerCache();
    const after = getServer(MAINNET_RPC);
    expect(after).not.toBe(before);
    expect(after).toBeInstanceOf(SorobanRpc.Server);
  });

  it('is idempotent — calling it multiple times does not throw', () => {
    getServer(MAINNET_RPC);
    clearServerCache();
    clearServerCache();
    clearServerCache();
    // No throw = pass
  });

  it('allows caching again after clearing', () => {
    getServer(MAINNET_RPC);
    clearServerCache();
    const a = getServer(MAINNET_RPC);
    const b = getServer(MAINNET_RPC);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Integration: getServer used within buildContractCallTx path
// ---------------------------------------------------------------------------

describe('server cache integration', () => {
  beforeEach(() => {
    clearServerCache();
  });

  it('getServer is exported from the public API (index.ts)', async () => {
    // Dynamic import to avoid circular deps during vitest bootstrap
    const mod = await import('../index.js');
    expect(mod.getServer).toBe(getServer);
    expect(mod.clearServerCache).toBe(clearServerCache);
  });

  it('cache does not leak between test suites when beforeEach clears', () => {
    // This test itself is the assertion — beforeEach runs and the cache
    // is clean. Verifying that getServer still works post-clear.
    const server = getServer(MAINNET_RPC);
    expect(server).toBeInstanceOf(SorobanRpc.Server);
  });
});
