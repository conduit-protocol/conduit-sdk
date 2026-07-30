import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanRpc, xdr, nativeToScVal, StrKey, Keypair } from '@stellar/stellar-sdk';
import crypto from 'crypto';

// ── soroban.ts: simulateReadOnly error paths ───────────────────────────────────

describe('simulateReadOnly — error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when simulation returns no result', async () => {
    vi.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue({ result: null } as any);

    const { simulateReadOnly, clearServerCache } = await import('../soroban.js');
    clearServerCache();
    await expect(
      simulateReadOnly('http://localhost:8000', 'testnet', {} as any),
    ).rejects.toThrow('Simulation returned no result');
  });

  it('throws on simulation error', async () => {
    vi.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue({ error: 'Contract error' } as any);

    const { simulateReadOnly, clearServerCache } = await import('../soroban.js');
    clearServerCache();
    await expect(
      simulateReadOnly('http://localhost:8000', 'testnet', {} as any),
    ).rejects.toThrow('Simulation error');
  });
});

// ── soroban.ts: getTokenDecimals ───────────────────────────────────────────────

describe('getTokenDecimals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the u32 value', async () => {
    const pk = Keypair.random().publicKey();
    let seq = '1';
    vi.spyOn(SorobanRpc.Server.prototype, 'getAccount')
      .mockResolvedValue({
        accountId: () => pk,
        sequenceNumber: () => seq,
        incrementSequenceNumber: () => { seq = String(Number(seq) + 1); return seq; },
      } as any);
    vi.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue({
        result: {
          retval: { toXDR: () => xdr.ScVal.scvU32(7).toXDR() },
        },
      } as any);

    const buf = Buffer.alloc(32);
    crypto.randomFillSync(buf);
    const contractId = StrKey.encodeContract(buf);

    const { getTokenDecimals, clearServerCache } = await import('../soroban.js');
    clearServerCache();
    const decimals = await getTokenDecimals('http://localhost:8000', 'testnet', pk, contractId);
    expect(decimals).toBe(7);
  });
});

// ── nonce-manager.ts: NaN branch ───────────────────────────────────────────────

describe('NonceManager — NaN handling', () => {
  it('increments currentNonce when network returns NaN', async () => {
    const { NonceManager } = await import('../nonce-manager.js');
    const nm = new NonceManager();
    const next = await nm.getNextNonce(async () => NaN);
    expect(next).toBe(1);
  });

  it('increments on fetch error', async () => {
    const { NonceManager } = await import('../nonce-manager.js');
    const nm = new NonceManager();
    const next = await nm.getNextNonce(async () => { throw new Error('network down'); });
    expect(next).toBe(1);
  });
});

// ── events.ts: addressField catch ──────────────────────────────────────────────

describe('dispatchEvent — addressField fallback', () => {
  it('handles invalid address in topic gracefully', async () => {
    const { dispatchEvent } = await import('../events.js');
    const onCancel = vi.fn();
    dispatchEvent(
      {
        topic: [xdr.ScVal.scvSymbol('cancelled'), xdr.ScVal.scvSymbol('not_an_address')],
        value: xdr.ScVal.scvVec([
          nativeToScVal(100n, { type: 'i128' }),
          nativeToScVal(500n, { type: 'i128' }),
        ]),
      },
      { onCancel } as any,
    );
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ sender: '', refundAmount: 100n, withdrawnSoFar: 500n }),
    );
  });
});

// ── builder.ts: ConduitBatcher abort handling ────────────────────────────────

describe('ConduitBatcher — abort signal', () => {
  it('resolves with error when aborted before processing', async () => {
    const { ConduitBatcher } = await import('../builder.js');
    const ac = new AbortController();
    ac.abort();
    const result = await ConduitBatcher.executeAsync(
      [{ operation: 'create_stream', params: {} }],
      ac.signal,
    );
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Operation aborted');
  });
});

// ── streams.ts: _ensureCanMutate with signer ──────────────────────────────────

describe('StreamsModule — _ensureCanMutate with signer', () => {
  it('succeeds with only a signer', async () => {
    const buf = Buffer.alloc(32);
    crypto.randomFillSync(buf);
    const contractId = StrKey.encodeContract(buf);

    const { StreamsModule } = await import('../streams.js');
    const streams = new StreamsModule({
      network: 'testnet',
      factoryAddress: contractId,
      signer: { sign: vi.fn(), publicKey: () => Keypair.random().publicKey() },
    } as any);
    expect(() => (streams as any)._ensureCanMutate()).not.toThrow();
  });
});
