import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeeEstimator } from '../fee-estimator.js';

describe('FeeEstimator — edge cases', () => {
  describe('with minRefetchInterval', () => {
    it('returns cached value within refetch interval', async () => {
      const fetcher = vi.fn().mockResolvedValue(200);
      const estimator = new FeeEstimator(100, { minRefetchIntervalMs: 10000 });

      const first = await estimator.estimateFee(fetcher);
      expect(first).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);

      const second = await estimator.estimateFee(fetcher);
      expect(second).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('fetches again after refetch interval expires', async () => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(200);
      const estimator = new FeeEstimator(50, { minRefetchIntervalMs: 1 });

      const first = await estimator.estimateFee(fetcher);
      expect(first).toBe(100);

      await new Promise(r => setTimeout(r, 5));

      const second = await estimator.estimateFee(fetcher);
      expect(second).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('returns initial fee on network failure', async () => {
      const estimator = new FeeEstimator(100);
      const result = await estimator.estimateFee(
        () => Promise.reject(new Error('Network down')),
      );
      expect(result).toBe(100);
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const estimator = new FeeEstimator(50);
      await estimator.estimateFee(
        () => Promise.reject(new Error('Timeout')),
        { onError },
      );
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('recovers after a failure', async () => {
      let shouldFail = true;
      const estimator = new FeeEstimator(50);
      const fetcher = vi.fn().mockImplementation(() => {
        if (shouldFail) return Promise.reject(new Error('Temporary'));
        return Promise.resolve(200);
      });

      const first = await estimator.estimateFee(fetcher);
      expect(first).toBe(50);

      shouldFail = false;
      const second = await estimator.estimateFee(fetcher);
      expect(second).toBe(200);
    });

    it('handles non-Error fetch failures', async () => {
      const estimator = new FeeEstimator(100);
      const result = await estimator.estimateFee(
        () => Promise.reject('string error'),
      );
      expect(result).toBe(100);
    });
  });

  describe('concurrent requests', () => {
    it('deduplicates concurrent requests', async () => {
      const fetcher = vi.fn().mockResolvedValue(300);
      const estimator = new FeeEstimator(100);

      const results = await Promise.all(
        Array.from({ length: 50 }, () => estimator.estimateFee(fetcher)),
      );
      expect(results.every(r => r === 300)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('deduplicates within refetch interval', async () => {
      const fetcher = vi.fn().mockResolvedValue(500);
      const estimator = new FeeEstimator(200, { minRefetchIntervalMs: 5000 });

      const results = await Promise.all(
        Array.from({ length: 20 }, () => estimator.estimateFee(fetcher)),
      );
      expect(results.every(r => r === 500)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('state getters', () => {
    it('tracks isEstimating during fetch', async () => {
      const estimator = new FeeEstimator(100);
      let resolveFetch: (v: number) => void;
      const fetcher = () => new Promise<number>(resolve => { resolveFetch = resolve; });

      const promise = estimator.estimateFee(fetcher);
      expect(estimator._isEstimating).toBe(true);
      resolveFetch!(200);
      await promise;
    });

    it('reports stale after error', async () => {
      const estimator = new FeeEstimator(100);
      await estimator.estimateFee(() => Promise.reject(new Error('fail')));
      expect(estimator.isStale).toBe(true);
      expect(estimator.lastError).toBeTruthy();
    });

    it('returns baseFee without network call', () => {
      const estimator = new FeeEstimator(250);
      expect(estimator.getBaseFee()).toBe(250);
    });
  });
});
