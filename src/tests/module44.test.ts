import { describe, it, expect, beforeEach } from 'vitest';
import { Module44 } from '../module44.js';
import type { StreamInfo } from '../types/index.js';

describe('Module44 (SDK Feature #44)', () => {
  let module44: Module44;
  const now = 1_000_000;

  const mockStream: StreamInfo = {
    id: 1n,
    address: 'CCSTREAM44ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYC3ZCHB2D4P3CF',
    recipient: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    token: 'native',
    ratePerSecond: 100n,
    startTime: now - 500,
    endTime: now + 500,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
  };

  beforeEach(() => {
    module44 = new Module44({ cacheSize: 10, batchChunkSize: 5 });
  });

  describe('Constructor & Configuration', () => {
    it('initializes with default options and no speedup measurement yet', () => {
      const defaultMod = new Module44();
      const metrics = defaultMod.getPerformanceMetrics();
      expect(metrics.totalAssessed).toBe(0);
      expect(metrics.measuredSpeedupPercent).toBeNull();
    });

    it('never reports a speedup when optimization is disabled', () => {
      const customMod = new Module44({ enableOptimization: false });
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };
      customMod.assessSingleItem(item);
      customMod.assessSingleItem(item);
      expect(customMod.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });

    it('throws when criticalThresholdSecs is negative', () => {
      expect(() => new Module44({ criticalThresholdSecs: -1 })).toThrow(/criticalThresholdSecs/);
    });

    it('throws when warningThresholdSecs does not exceed criticalThresholdSecs', () => {
      expect(() => new Module44({ criticalThresholdSecs: 100, warningThresholdSecs: 100 })).toThrow(/warningThresholdSecs/);
      expect(() => new Module44({ criticalThresholdSecs: 100, warningThresholdSecs: 50 })).toThrow(/warningThresholdSecs/);
    });
  });

  describe('assessSingleItem — risk classification', () => {
    it('classifies a cancelled stream as inactive with zero runway', () => {
      const item = { id: 's1', stream: { ...mockStream, cancelled: true }, timestamp: now };
      const result = module44.assessSingleItem(item);
      expect(result).toMatchObject({ id: 's1', runwaySecs: 0, riskLevel: 'inactive', isCached: false, computedAt: now });
    });

    it('classifies a paused stream as inactive with zero runway', () => {
      const item = { id: 's1', stream: { ...mockStream, paused: true }, timestamp: now };
      const result = module44.assessSingleItem(item);
      expect(result.riskLevel).toBe('inactive');
      expect(result.runwaySecs).toBe(0);
    });

    it('classifies a zero-rate stream as inactive', () => {
      const item = { id: 's1', stream: { ...mockStream, ratePerSecond: 0n }, timestamp: now };
      const result = module44.assessSingleItem(item);
      expect(result.riskLevel).toBe('inactive');
    });

    describe('open-ended streams (endTime === 0)', () => {
      it('classifies an active open-ended stream as healthy with null runway', () => {
        const item = { id: 's1', stream: { ...mockStream, endTime: 0 }, timestamp: now };
        const result = module44.assessSingleItem(item);
        expect(result.runwaySecs).toBeNull();
        expect(result.riskLevel).toBe('healthy');
      });

      it('classifies an open-ended stream with zero rate as inactive', () => {
        const item = { id: 's1', stream: { ...mockStream, endTime: 0, ratePerSecond: 0n }, timestamp: now };
        const result = module44.assessSingleItem(item);
        expect(result.runwaySecs).toBe(0);
        expect(result.riskLevel).toBe('inactive');
      });

      it('classifies a paused open-ended stream as inactive with zero runway', () => {
        const item = { id: 's1', stream: { ...mockStream, endTime: 0, paused: true }, timestamp: now };
        const result = module44.assessSingleItem(item);
        expect(result.runwaySecs).toBe(0);
        expect(result.riskLevel).toBe('inactive');
      });

      it('classifies a cancelled open-ended stream as inactive with zero runway', () => {
        const item = { id: 's1', stream: { ...mockStream, endTime: 0, cancelled: true }, timestamp: now };
        const result = module44.assessSingleItem(item);
        expect(result.runwaySecs).toBe(0);
        expect(result.riskLevel).toBe('inactive');
      });

      it('preserves null runway and healthy risk classification when retrieved from cache', () => {
        const mod = new Module44({ enableOptimization: true });
        const item = { id: 'open-cache-1', stream: { ...mockStream, endTime: 0 }, timestamp: now };
        const first = mod.assessSingleItem(item);
        expect(first.isCached).toBe(false);
        expect(first.runwaySecs).toBeNull();
        expect(first.riskLevel).toBe('healthy');

        const cached = mod.assessSingleItem(item);
        expect(cached.isCached).toBe(true);
        expect(cached.runwaySecs).toBeNull();
        expect(cached.riskLevel).toBe('healthy');
      });
    });

    it('classifies runway already past endTime as inactive', () => {
      const item = { id: 's1', stream: { ...mockStream, endTime: now - 1 }, timestamp: now };
      const result = module44.assessSingleItem(item);
      expect(result.runwaySecs).toBe(0);
      expect(result.riskLevel).toBe('inactive');
    });

    it('classifies runway below the critical threshold as critical', () => {
      const item = { id: 's1', stream: { ...mockStream, endTime: now + 3600 }, timestamp: now }; // 1 hour
      const result = module44.assessSingleItem(item);
      expect(result.runwaySecs).toBe(3600);
      expect(result.riskLevel).toBe('critical');
    });

    it('classifies runway between critical and warning thresholds as warning', () => {
      const item = { id: 's1', stream: { ...mockStream, endTime: now + 172_800 }, timestamp: now }; // 2 days
      const result = module44.assessSingleItem(item);
      expect(result.riskLevel).toBe('warning');
    });

    it('classifies runway above the warning threshold as healthy', () => {
      const item = { id: 's1', stream: { ...mockStream, endTime: now + 1_000_000 }, timestamp: now };
      const result = module44.assessSingleItem(item);
      expect(result.riskLevel).toBe('healthy');
    });

    it('honours custom critical/warning thresholds', () => {
      const custom = new Module44({ criticalThresholdSecs: 10, warningThresholdSecs: 20 });
      const item = { id: 's1', stream: { ...mockStream, endTime: now + 15 }, timestamp: now };
      expect(custom.assessSingleItem(item).riskLevel).toBe('warning');
    });

    it('uses system current time if timestamp is omitted', () => {
      const item = { id: 's1', stream: mockStream };
      const result = module44.assessSingleItem(item);
      expect(result.computedAt).toBeGreaterThan(0);
    });
  });

  describe('Optimization & Caching', () => {
    it('serves cached results on duplicate evaluation requests', () => {
      const item = { id: 's1', stream: mockStream, timestamp: now };

      const firstPass = module44.assessSingleItem(item);
      expect(firstPass.isCached).toBe(false);

      const secondPass = module44.assessSingleItem(item);
      expect(secondPass.isCached).toBe(true);
      expect(secondPass.riskLevel).toBe(firstPass.riskLevel);

      const metrics = module44.getPerformanceMetrics();
      expect(metrics.cacheHits).toBe(1);
      expect(metrics.cacheMisses).toBe(1);
      expect(
        metrics.measuredSpeedupPercent === null || typeof metrics.measuredSpeedupPercent === 'number',
      ).toBe(true);
    });

    it('evicts oldest cache item when cacheSize threshold is reached', () => {
      const smallCacheMod = new Module44({ cacheSize: 2 });

      smallCacheMod.assessSingleItem({ id: 'item-1', stream: mockStream, timestamp: 1000 });
      smallCacheMod.assessSingleItem({ id: 'item-2', stream: mockStream, timestamp: 1001 });
      smallCacheMod.assessSingleItem({ id: 'item-3', stream: mockStream, timestamp: 1002 });

      const reQuery = smallCacheMod.assessSingleItem({ id: 'item-1', stream: mockStream, timestamp: 1000 });
      expect(reQuery.isCached).toBe(false);
    });

    it('bypasses cache when optimization is disabled', () => {
      const unoptimizedMod = new Module44({ enableOptimization: false });
      const item = { id: 's1', stream: mockStream, timestamp: now };

      unoptimizedMod.assessSingleItem(item);
      const secondPass = unoptimizedMod.assessSingleItem(item);

      expect(secondPass.isCached).toBe(false);
      expect(unoptimizedMod.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('assessBatch', () => {
    it('assesses a batch of stream items in chunked iterations', () => {
      const batchItems = Array.from({ length: 12 }, (_, i) => ({
        id: `stream-${i}`,
        stream: { ...mockStream, id: BigInt(i) },
        timestamp: now,
      }));

      const results = module44.assessBatch(batchItems);

      expect(results).toHaveLength(12);
      expect(results[0]?.id).toBe('stream-0');
      expect(results[11]?.id).toBe('stream-11');

      expect(module44.getPerformanceMetrics().totalAssessed).toBe(12);
    });

    it('reports the same totalAssessed whether items go through assessBatch or assessSingleItem directly', () => {
      const viaSingle = new Module44({ cacheSize: 10 });
      viaSingle.assessSingleItem({ id: 'a', stream: mockStream, timestamp: now });
      viaSingle.assessSingleItem({ id: 'b', stream: { ...mockStream, id: 2n }, timestamp: now });
      expect(viaSingle.getPerformanceMetrics().totalAssessed).toBe(2);

      const viaBatch = new Module44({ cacheSize: 10 });
      viaBatch.assessBatch([
        { id: 'a', stream: mockStream, timestamp: now },
        { id: 'b', stream: { ...mockStream, id: 2n }, timestamp: now },
      ]);
      expect(viaBatch.getPerformanceMetrics().totalAssessed).toBe(2);
    });

    it('accurately assesses mixed batches containing both open-ended and bounded streams', () => {
      const items = [
        { id: 'open-1', stream: { ...mockStream, id: 1n, endTime: 0 }, timestamp: now },
        { id: 'bounded-critical', stream: { ...mockStream, id: 2n, endTime: now + 1000 }, timestamp: now },
        { id: 'open-paused', stream: { ...mockStream, id: 3n, endTime: 0, paused: true }, timestamp: now },
      ];

      const results = module44.assessBatch(items);
      expect(results[0]?.runwaySecs).toBeNull();
      expect(results[0]?.riskLevel).toBe('healthy');

      expect(results[1]?.runwaySecs).toBe(1000);
      expect(results[1]?.riskLevel).toBe('critical');

      expect(results[2]?.runwaySecs).toBe(0);
      expect(results[2]?.riskLevel).toBe('inactive');
    });
  });

  describe('estimateTopUpNeeded', () => {
    it('returns 0n when the target runway is already met', () => {
      const stream = { ...mockStream, endTime: now + 10_000 };
      expect(module44.estimateTopUpNeeded(stream, 100, now)).toBe(0n);
    });

    it('computes the exact deficit amount in stroops for a bounded stream', () => {
      const stream = { ...mockStream, endTime: now + 100, ratePerSecond: 50n };
      // Needs runway of 200s but only has 100s -> 100s deficit * 50/s = 5000n
      expect(module44.estimateTopUpNeeded(stream, 200, now)).toBe(5000n);
    });

    describe('open-ended streams (endTime === 0)', () => {
      it('returns 0n for an active open-ended stream across various target runways', () => {
        const stream = { ...mockStream, endTime: 0, ratePerSecond: 100n };
        expect(module44.estimateTopUpNeeded(stream, 10, now)).toBe(0n);
        expect(module44.estimateTopUpNeeded(stream, 3600, now)).toBe(0n);
        expect(module44.estimateTopUpNeeded(stream, 86400 * 365, now)).toBe(0n);
        expect(module44.estimateTopUpNeeded(stream, 1_000_000_000, now)).toBe(0n);
      });

      it('returns 0n for a paused open-ended stream', () => {
        const stream = { ...mockStream, endTime: 0, paused: true, ratePerSecond: 100n };
        expect(module44.estimateTopUpNeeded(stream, 1000, now)).toBe(0n);
      });

      it('returns 0n for a cancelled open-ended stream', () => {
        const stream = { ...mockStream, endTime: 0, cancelled: true, ratePerSecond: 100n };
        expect(module44.estimateTopUpNeeded(stream, 1000, now)).toBe(0n);
      });

      it('returns 0n for an open-ended stream when nowSec is far in the future', () => {
        const stream = { ...mockStream, endTime: 0, ratePerSecond: 50n };
        expect(module44.estimateTopUpNeeded(stream, 5000, now + 10_000_000)).toBe(0n);
      });
    });

    it('returns 0n for non-positive target runway', () => {
      expect(module44.estimateTopUpNeeded(mockStream, 0, now)).toBe(0n);
      expect(module44.estimateTopUpNeeded(mockStream, -10, now)).toBe(0n);
    });

    it('returns 0n for a zero-rate, paused, or cancelled stream', () => {
      expect(module44.estimateTopUpNeeded({ ...mockStream, ratePerSecond: 0n }, 1000, now)).toBe(0n);
      expect(module44.estimateTopUpNeeded({ ...mockStream, paused: true }, 1000, now)).toBe(0n);
      expect(module44.estimateTopUpNeeded({ ...mockStream, cancelled: true }, 1000, now)).toBe(0n);
    });

    it('defaults nowSec to the current time when omitted', () => {
      const stream = { ...mockStream, endTime: 0 };
      expect(() => module44.estimateTopUpNeeded(stream, 1000)).not.toThrow();
    });
  });

  describe('clearCache & Metrics', () => {
    it('resets cache state and performance counters', () => {
      const item = { id: 's1', stream: mockStream, timestamp: now };
      module44.assessSingleItem(item);
      module44.assessSingleItem(item);

      expect(module44.getPerformanceMetrics().cacheHits).toBe(1);

      module44.clearCache();

      const freshMetrics = module44.getPerformanceMetrics();
      expect(freshMetrics.cacheHits).toBe(0);
      expect(freshMetrics.cacheMisses).toBe(0);
      expect(freshMetrics.totalAssessed).toBe(0);
    });
  });
});
