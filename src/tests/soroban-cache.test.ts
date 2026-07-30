import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { getServer, clearServerCache } from '../soroban.js';

describe('SorobanRpc.Server caching', () => {
  beforeEach(() => clearServerCache());
  afterEach(() => clearServerCache());

  it('returns the same instance for the same URL', () => {
    const s1 = getServer('https://soroban-testnet.stellar.org');
    const s2 = getServer('https://soroban-testnet.stellar.org');
    expect(s1).toBe(s2);
  });

  it('returns different instances for different URLs', () => {
    const s1 = getServer('https://soroban-testnet.stellar.org');
    const s2 = getServer('https://soroban-mainnet.stellar.org');
    expect(s1).not.toBe(s2);
  });

  it('creates server with allowHttp for http:// URLs', () => {
    const s = getServer('http://localhost:8000/soroban/rpc');
    expect(s).toBeDefined();
  });

  it('clears cache on clearServerCache', () => {
    const s1 = getServer('https://soroban-testnet.stellar.org');
    clearServerCache();
    const s2 = getServer('https://soroban-testnet.stellar.org');
    expect(s1).not.toBe(s2);
  });
});
