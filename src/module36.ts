import type { StreamInfo } from './types/index.js';
import { streamProgress, withdrawableLocal } from './utils.js';

export interface Module36Config {
  /** Maximum number of snapshot diffs retained in the LRU cache */
  cacheSize?: number;
  /** Enable memoized diffing; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
}

export interface StreamSnapshot {
  stream: StreamInfo;
  /** Observation timestamp (unix seconds) */
  observedAt: number;
}

export interface StreamDiff {
  streamId: string;
  withdrawableDelta: bigint;
  progressDelta: number;
  statusChanged: boolean;
  previousWithdrawable: bigint;
  currentWithdrawable: bigint;
  previousProgress: number;
  currentProgress: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module36Metrics {
  totalDiffs: number;
  cacheHits: number;
  cacheMisses: number;
  /**
   * Measured, not assumed: `(avgMissMs - avgHitMs) / avgMissMs * 100`, based
   * on this instance's own accumulated timings. `null` until at least one
   * hit and one miss have both been recorded (nothing to compare yet).
   */
  measuredSpeedupPercent: number | null;
  averageExecutionTimeMs: number;
}

function normalizeProgress(value: number): number {
  return Number.isNaN(value) ? 0.5 : value;
}

function statusKey(stream: StreamInfo): string {
  return `${stream.paused ? 1 : 0}:${stream.cancelled ? 1 : 0}:${stream.endTime}`;
}

/**
 * Module 36: stream snapshot diff engine with LRU-memoized diffing.
 *
 * Implements Feature #36. Speedup from caching is workload-dependent
 * (proportional to cache hit rate); call `getPerformanceMetrics()` for
 * this instance's own measured hit/miss timing rather than assuming a
 * fixed percentage.
 */
export class Module36 {
  private readonly cacheSize: number;
  private readonly enableOptimization: boolean;

  private cache = new Map<string, StreamDiff>();
  private totalDiffs = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalExecutionTimeMs = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;

  constructor(config: Module36Config = {}) {
    this.cacheSize = config.cacheSize ?? 1000;
    this.enableOptimization = config.enableOptimization ?? true;
  }

  /**
   * Diff two snapshots of the same stream, returning withdrawable/progress deltas.
   */
  public diffSnapshots(previous: StreamSnapshot, current: StreamSnapshot): StreamDiff {
    const start = performance.now();
    const streamId = current.stream.id.toString();
    const cacheKey = [
      streamId,
      previous.observedAt,
      current.observedAt,
      previous.stream.withdrawn.toString(),
      current.stream.withdrawn.toString(),
      statusKey(previous.stream),
      statusKey(current.stream),
    ].join('|');

    if (this.enableOptimization) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cacheHits++;
        this.totalDiffs++;
        this.totalExecutionTimeMs += elapsed;
        this.hitExecutionTimeMs += elapsed;
        // Refresh LRU order
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return { ...cached, isCached: true };
      }
    }

    this.cacheMisses++;
    const previousWithdrawable = withdrawableLocal(previous.stream, previous.observedAt);
    const currentWithdrawable = withdrawableLocal(current.stream, current.observedAt);
    const previousProgress = normalizeProgress(streamProgress(previous.stream, previous.observedAt));
    const currentProgress = normalizeProgress(streamProgress(current.stream, current.observedAt));

    const result: StreamDiff = {
      streamId,
      withdrawableDelta: currentWithdrawable - previousWithdrawable,
      progressDelta: currentProgress - previousProgress,
      statusChanged: statusKey(previous.stream) !== statusKey(current.stream),
      previousWithdrawable,
      currentWithdrawable,
      previousProgress,
      currentProgress,
      isCached: false,
      computedAt: current.observedAt,
    };

    if (this.enableOptimization) {
      if (this.cache.size >= this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, result);
    }

    const elapsed = performance.now() - start;
    this.totalDiffs++;
    this.totalExecutionTimeMs += elapsed;
    this.missExecutionTimeMs += elapsed;
    return result;
  }

  /**
   * Diff many snapshot pairs in a single pass (pre-sized result buffer).
   */
  public diffBatch(
    pairs: Array<{ previous: StreamSnapshot; current: StreamSnapshot }>,
  ): StreamDiff[] {
    const results: StreamDiff[] = new Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (!pair) continue;
      results[i] = this.diffSnapshots(pair.previous, pair.current);
    }
    return results;
  }

  /**
   * Fast BigInt accrual between two timestamps at a constant rate.
   */
  public computeAccrual(ratePerSecond: bigint, fromSec: number, toSec: number): bigint {
    if (ratePerSecond <= 0n || toSec <= fromSec) return 0n;
    return ratePerSecond * BigInt(toSec - fromSec);
  }

  public clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalDiffs = 0;
    this.totalExecutionTimeMs = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  public getPerformanceMetrics(): Module36Metrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return {
      totalDiffs: this.totalDiffs,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs:
        this.totalDiffs > 0 ? this.totalExecutionTimeMs / this.totalDiffs : 0,
    };
  }
}
