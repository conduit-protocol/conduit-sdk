import { describe, it, expect, vi } from 'vitest';
import { RateLimitError } from '../errors.js';

const mockSimulateTransaction = vi.fn();
const mockGetAccount = vi.fn();
const mockSendTransaction = vi.fn();
const mockGetTransaction = vi.fn();

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return {
          simulateTransaction: mockSimulateTransaction,
          getAccount: mockGetAccount,
          sendTransaction: mockSendTransaction,
          getTransaction: mockGetTransaction,
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
      assembleTransaction: (actual as any).SorobanRpc.assembleTransaction,
    },
  };
});


import { simulateReadOnly } from '../soroban.js';

describe('soroban.ts rate limit handling', () => {
  it('converts a 429 thrown by simulateTransaction into a RateLimitError', async () => {
    const axiosStyle429 = {
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '1' } },
    };
    mockSimulateTransaction.mockRejectedValueOnce(axiosStyle429);

    await expect(
      simulateReadOnly('http://localhost:8000', 'passphrase', {} as any)
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('still throws the original error for non-rate-limit failures', async () => {
    mockSimulateTransaction.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      simulateReadOnly('http://localhost:8000', 'passphrase', {} as any)
    ).rejects.toThrow('ECONNREFUSED');
  });
});