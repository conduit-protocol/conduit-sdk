import { describe, it, expect, vi } from 'vitest';
import { FeeEstimator } from '../fee-estimator.js';

describe('FeeEstimator - Race condition and edge cases', () => {
  it('should gracefully handle 100+ rapid simultaneous requests without race conditions', async () => {
    const estimator = new FeeEstimator(100);
    
    // Simulate network latency and a fetcher
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return new Promise<number>((resolve) => {
        setTimeout(() => resolve(150.123456789), 50); // Artificially introduce network latency
      });
    };

    // Trigger 150 rapid requests simultaneously
    const promises = [];
    for (let i = 0; i < 150; i++) {
      promises.push(estimator.estimateFee(fetcher));
    }

    const results = await Promise.all(promises);

    // Assert that the network fetch was only performed once due to the locking mechanism
    expect(fetchCount).toBe(1);

    // Assert that all returned values correctly parsed precision and floating math
    results.forEach(res => {
      expect(res).toBe(150.1234568); // rounded to 7 places
    });
    
    expect(estimator.getBaseFee()).toBe(150.1234568);
    expect(estimator.lastSuccessfulFetchAt).toEqual(expect.any(Number));
    expect(estimator.lastError).toBeNull();
    expect(estimator.isStale).toBe(false);
  });

  it('should surface the specific error when falling back after network failure', async () => {
    const estimator = new FeeEstimator(100);
    const onError = vi.fn();
    
    const failingFetcher = async () => {
      throw new Error('Network error');
    };

    const fee = await estimator.estimateFee(failingFetcher, { onError });
    
    // Fallback should return the original base fee
    expect(fee).toBe(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe('Network error');
    expect(estimator.lastError?.message).toBe('Network error');
    expect(estimator.lastSuccessfulFetchAt).toBeNull();
    expect(estimator.isStale).toBe(true);
  });
  
  it('should expose stale state when invalid math falls back', async () => {
    const estimator = new FeeEstimator(100);
    const onError = vi.fn();
    
    const badMathFetcher = async () => {
      return NaN; 
    };

    const fee = await estimator.estimateFee(badMathFetcher, { onError });
    // Boundary checks should catch this and fallback
    expect(fee).toBe(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('Invalid network fee response');
    expect(estimator.lastError?.message).toBe('Invalid network fee response');
    expect(estimator.isStale).toBe(true);
  });

  it('should handle multiple sequential requests successfully', async () => {
    const estimator = new FeeEstimator(100);
    
    const fetcher1 = async () => 120.5;
    const fetcher2 = async () => 130.5;

    const fee1 = await estimator.estimateFee(fetcher1);
    expect(fee1).toBe(120.5);
    
    const fee2 = await estimator.estimateFee(fetcher2);
    expect(fee2).toBe(130.5);
    expect(estimator.isStale).toBe(false);
  });

  it('should clear stale status after a later successful fetch', async () => {
    const estimator = new FeeEstimator(100);

    await estimator.estimateFee(async () => {
      throw new Error('temporary outage');
    });
    expect(estimator.isStale).toBe(true);
    expect(estimator.lastError?.message).toBe('temporary outage');

    const recoveredFee = await estimator.estimateFee(async () => 140.25);
    expect(recoveredFee).toBe(140.25);
    expect(estimator.lastError).toBeNull();
    expect(estimator.lastSuccessfulFetchAt).toEqual(expect.any(Number));
    expect(estimator.isStale).toBe(false);
  });
});
