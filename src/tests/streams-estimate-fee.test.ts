import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockStreamAddress, mockSimulate } = vi.hoisted(() => ({
  mockStreamAddress: vi.fn(),
  mockSimulate:      vi.fn(),
}));

vi.mock('../factory.js', () => ({
  FactoryModule: class {
    streamAddress = mockStreamAddress;
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
    catchNetworkError: <T>(_label: string, promise: Promise<T>) => promise,
  };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
    },
  };
});

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const STREAM_ADDR  = StrKey.encodeContract(Buffer.alloc(32, 2));

function makeConfig(overrides: Partial<ConduitConfig> = {}): ConduitConfig {
  return { network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random(), ...overrides };
}

describe('StreamsModule.estimateFee', () => {
  beforeEach(() => {
    mockStreamAddress.mockReset().mockResolvedValue(STREAM_ADDR);
    mockSimulate.mockReset();
  });

  it('returns every fee field as bigint stroops', async () => {
    mockSimulate.mockResolvedValue({ minResourceFee: '12345', cost: { cpuInsns: '678' } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({ type: 'cancel', streamId: 1n });

    expect(typeof est.totalFee).toBe('bigint');
    expect(typeof est.resourceFee).toBe('bigint');
    expect(typeof est.baseFee).toBe('bigint');
    expect(typeof est.instructions).toBe('bigint');
    expect(est.resourceFee).toBe(12_345n);
    expect(est.instructions).toBe(678n);
    expect(est.totalFee).toBe(est.baseFee + est.resourceFee);
  });

  it('stays exact for a resource fee beyond Number.MAX_SAFE_INTEGER', async () => {
    const huge = '9007199254740993'; // 2^53 + 1
    mockSimulate.mockResolvedValue({ minResourceFee: huge, cost: { cpuInsns: '1' } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({ type: 'pause', streamId: 2n });
    expect(est.resourceFee).toBe(9_007_199_254_740_993n);
  });

  it('falls back to the default resource-fee estimate when the sim omits fee fields', async () => {
    const { DEFAULT_RESOURCE_FEE_ESTIMATE } = await import('../soroban.js');
    mockSimulate.mockResolvedValue({ cost: { cpuInsns: '0' } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({ type: 'resume', streamId: 3n });
    expect(est.resourceFee).toBe(DEFAULT_RESOURCE_FEE_ESTIMATE);
  });
});
