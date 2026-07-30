import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockSimulateTransaction,
  mockSendTransaction,
  mockGetTransaction,
  mockAssembleTransaction,
} = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockGetTransaction: vi.fn(),
  mockAssembleTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return {
          simulateTransaction: mockSimulateTransaction,
          sendTransaction: mockSendTransaction,
          getTransaction: mockGetTransaction,
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
      assembleTransaction: mockAssembleTransaction,
    },
  };
});

import { invokeContract } from '../soroban.js';
import type { Signer } from '../signer.js';

function makeSigner(): Signer {
  return {
    sign: vi.fn().mockResolvedValue(undefined),
    publicKey: () => 'GABC',
  };
}

describe('invokeContract — submission error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssembleTransaction.mockReturnValue({ build: vi.fn().mockReturnValue({}) });
  });

  it('handles sendTransaction ERROR status', async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: { message: 'bad' },
    });

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('Transaction rejected');
  });

  it('handles getTransaction FAILED status', async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: '0'.repeat(64) });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('Transaction failed');
  });

  it('handles simulation error', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'simulation error' } as any);

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('Simulation failed');
  });

  it('handles sendTransaction throw', async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockRejectedValue(new Error('network error'));

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('network error');
  });

  it('handles getTransaction throw', async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: '0'.repeat(64) });
    mockGetTransaction.mockRejectedValue(new Error('get error'));

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('get error');
  });

  it('handles simulation throw', async () => {
    mockSimulateTransaction.mockRejectedValue(new Error('sim error'));

    await expect(
      invokeContract('http://localhost:8000', 'testnet', makeSigner(), {} as any),
    ).rejects.toThrow('sim error');
  });

  it('returns hash on getTransaction SUCCESS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'abcd1234' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const promise = invokeContract(
      'http://localhost:8000', 'testnet', makeSigner(), {} as any,
      { maxAttempts: 5, pollIntervalMs: 10 },
    );
    vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result).toBe('abcd1234');
    vi.useRealTimers();
  });

  it('throws on polling timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { toXDR: () => Buffer.from('') } },
    } as any);
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' });
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    const promise = invokeContract(
      'http://localhost:8000', 'testnet', makeSigner(), {} as any,
      { maxAttempts: 2, pollIntervalMs: 10 },
    );
    vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toThrow('timed out');
    vi.useRealTimers();
  });
});
