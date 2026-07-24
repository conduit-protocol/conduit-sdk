import { describe, it, expect } from 'vitest';
import { RateLimitError } from '../errors.js';

describe('RateLimitError.fromRpcError', () => {
  it('detects an axios-style 429 response and returns a RateLimitError', () => {
    const axiosStyleError = {
      message: 'Request failed with status code 429',
      isAxiosError: true,
      response: {
        status: 429,
        headers: { 'retry-after': '2' },
        data: {},
      },
    };

    const result = RateLimitError.fromRpcError(axiosStyleError);
    expect(result).toBeInstanceOf(RateLimitError);
    expect(result).toBeInstanceOf(Error);
    expect(result?.name).toBe('RateLimitError');
    expect(result?.retryAfterMs).toBe(2000);
  });

  it('detects a raw JSON-RPC rate-limit error object (not an Error instance)', () => {
    const rawJsonRpcError = { code: -32029, message: 'Too many requests' };

    const result = RateLimitError.fromRpcError(rawJsonRpcError);
    expect(result).toBeInstanceOf(RateLimitError);
    expect(result?.name).toBe('RateLimitError');
  });

  it('returns null for a non-rate-limit error, leaving it to be handled elsewhere', () => {
    const unrelatedError = new Error('Simulation failed: some contract error');
    expect(RateLimitError.fromRpcError(unrelatedError)).toBeNull();
  });

  it('returns null for a plain 500 server error', () => {
    const serverError = {
      message: 'Request failed with status code 500',
      response: { status: 500, headers: {}, data: {} },
    };
    expect(RateLimitError.fromRpcError(serverError)).toBeNull();
  });
});