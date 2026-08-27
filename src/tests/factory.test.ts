import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Hoist mocks so they can be referenced inside vi.mock() factories ──────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn().mockResolvedValue({ _stub: 'tx' }),
  mockSimulate: vi.fn(),
}));

// ── Mock soroban helpers — avoids real RPC calls and address validation ────────

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  scValToU64: (v: { u64: () => { toString: () => string } }) =>
    BigInt(v.u64().toString()),
  scValToI128: (_v: unknown) => 0n,
  scValToU32: (v: { switch: () => { name: string }; u32: () => number }) => {
    if (v.switch().name !== 'scvU32') {
      throw new Error(`Expected a u32 ScVal, got "${v.switch().name}" instead.`);
    }
    return v.u32();
  },
  NETWORK_PASSPHRASE: {
    testnet:  'Test SDF Network ; September 2015',
    mainnet:  'Public Global Stellar Network ; September 2015',
    local:    'Standalone Network ; February 2017',
  },
  DEFAULT_RPC: {
    testnet:  'https://soroban-testnet.stellar.org',
    mainnet:  'https://mainnet.sorobanrpc.com',
    local:    'http://localhost:8000/soroban/rpc',
  },
}));

// ── Mock Address so G-addresses are accepted without strkey validation ─────────

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');

  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal(_v: unknown) { return new MockAddress(''); }
    static fromString(s: string)  { return new MockAddress(s); }
  }

  return { ...actual, Address: MockAddress };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR   = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const SENDER_ADDR    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const RECIPIENT_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cfg(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    rpcUrl:         'https://soroban-testnet.stellar.org',
  };
}

function makeU64ScVal(n: bigint) {
  return _xdr.ScVal.scvU64(_xdr.Uint64.fromString(n.toString()));
}

function makeU32ScVal(n: number) {
  return _xdr.ScVal.scvU32(n);
}

function makeVoidScVal() {
  return _xdr.ScVal.scvVoid();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockBuildTx.mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset();
});

describe('FactoryModule — construction', () => {
  it('throws immediately when factoryAddress is missing, not deep inside stellar-sdk later', async () => {
    const { FactoryModule } = await import('../factory.js');
    expect(() => new FactoryModule({ network: 'testnet' })).toThrow(/factoryAddress is required/);
  });
});

describe('FactoryModule — streamCount()', () => {
  it('returns bigint parsed from u64 scval', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(42n));

    const count = await new FactoryModule(cfg()).streamCount();
    expect(count).toBe(42n);
  });

  it('returns 0n when contract has no streams', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(0n));

    const count = await new FactoryModule(cfg()).streamCount();
    expect(count).toBe(0n);
  });
});

describe('FactoryModule — streamAddress()', () => {
  it('returns null when contract returns void (stream not found)', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeVoidScVal());

    const addr = await new FactoryModule(cfg()).streamAddress(999n);
    expect(addr).toBeNull();
  });

  it('caches a resolved address and does not re-hit the network on the next call', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1)); // any non-void scval
    const factory = new FactoryModule(cfg());

    const first  = await factory.streamAddress(1n);
    const second = await factory.streamAddress(1n);

    expect(first).toBe(second);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('caches per streamId — a different id still hits the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate
      .mockResolvedValueOnce(makeU32ScVal(1))
      .mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(1n);
    await factory.streamAddress(2n);

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('accepts string and bigint streamId forms as the same cache key', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(5n);
    await factory.streamAddress('5');

    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('does not cache a not-found (void) result, so a later resolution still hits the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate
      .mockResolvedValueOnce(makeVoidScVal())
      .mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    const first  = await factory.streamAddress(7n);
    const second = await factory.streamAddress(7n);

    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});

describe('FactoryModule — protocolFeeBps()', () => {
  it('returns fee as a number', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(30));

    const fee = await new FactoryModule(cfg()).protocolFeeBps();
    expect(fee).toBe(30);
    expect(typeof fee).toBe('number');
  });

  it('handles zero fee', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(0));

    const fee = await new FactoryModule(cfg()).protocolFeeBps();
    expect(fee).toBe(0);
  });

  it('throws a clear typed error instead of a bare XDR error when the response is not a u32', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(30n));

    await expect(new FactoryModule(cfg()).protocolFeeBps()).rejects.toThrow(
      /Expected a u32 ScVal, got "scvU64"/,
    );
  });
});

describe('FactoryModule — streamsBySender() / streamsByRecipient()', () => {
  it('returns empty array when no streams exist', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    const ids = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(ids).toEqual([]);
  });

  it('returns bigint array of stream IDs', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('0')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('1')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('7')),
    ]));

    const ids = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(ids).toEqual([0n, 1n, 7n]);
  });

  it('streamsByRecipient parses identically to streamsBySender', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('3')),
    ]));

    const ids = await new FactoryModule(cfg()).streamsByRecipient(RECIPIENT_ADDR);
    expect(ids).toEqual([3n]);
  });

  it('clamps a limit above 100 to 100 before it reaches the contract call', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR, 0, 100_000);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(100);
  });

  it('clamps a negative limit to 0 rather than passing it through to a u32 conversion', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsByRecipient(RECIPIENT_ADDR, 0, -5);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(0);
  });

  it('leaves an in-range limit untouched', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR, 0, 50);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(50);
  });
});
