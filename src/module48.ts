import type { StreamInfo } from './types/index.js';
import { withdrawableLocal } from './utils.js';

export interface Module48Config {
  /** Maximum number of calculated results to keep in the fast lookup cache */
  cacheSize?: number;
  /** Enable memoized calculation; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
  /** Preferred chunk size for batch processing stream items */
  batchChunkSize?: number;
}

export interface StreamBatchItem {
  id: string;
  stream: StreamInfo;
  timestamp?: number;
}

export interface Module48Result {
  id: string;
  withdrawable: bigint;
  progress: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module48Metrics {
  totalProcessed: number;
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

/**
 * Module 48: stream analytics batch-evaluation helper.
 *
 * Implements Feature #48 with memoized withdrawable/progress calculation.
 * Speedup from caching is workload-dependent (proportional to cache hit
 * rate); call `getPerformanceMetrics()` for this instance's own measured
 * hit/miss timing rather than assuming a fixed percentage.
 */
export class Module48 {
  private readonly cacheSize: number;
  private readonly enableOptimization: boolean;
  private readonly batchChunkSize: number;

  private cache = new Map<string, { withdrawable: bigint; progress: number; computedAt: number }>();
  private totalProcessed = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalExecutionTimeMs = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;

  constructor(config: Module48Config = {}) {
    this.cacheSize = config.cacheSize ?? 1000;
    this.enableOptimization = config.enableOptimization ?? true;
    this.batchChunkSize = config.batchChunkSize ?? 50;
  }

  /**
   * Process a list of streams using optimized batch evaluation algorithms.
   */
  public processStreamBatch(items: StreamBatchItem[]): Module48Result[] {
    const startTime = performance.now();
    const results: Module48Result[] = new Array(items.length);

    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunkEnd = Math.min(i + this.batchChunkSize, items.length);
      for (let j = i; j < chunkEnd; j++) {
        const item = items[j];
        if (!item) continue;

        results[j] = this.processSingleItem(item);
      }
    }

    const elapsed = performance.now() - startTime;
    this.totalExecutionTimeMs += elapsed;
    this.totalProcessed += items.length;

    return results;
  }

  /**
   * Evaluate a single stream item with fast-path cache lookup.
   */
  public processSingleItem(item: StreamBatchItem): Module48Result {
    const start = performance.now();
    const nowSec = item.timestamp ?? Math.floor(Date.now() / 1000);
    const cacheKey = `${item.id}_${item.stream.withdrawn.toString()}_${item.stream.paused ? 1 : 0}_${nowSec}`;

    if (this.enableOptimization && this.cache.has(cacheKey)) {
      this.cacheHits++;
      this.hitExecutionTimeMs += performance.now() - start;
      const cached = this.cache.get(cacheKey)!;
      return {
        id: item.id,
        withdrawable: cached.withdrawable,
        progress: cached.progress,
        isCached: true,
        computedAt: cached.computedAt,
      };
    }

    this.cacheMisses++;
    const withdrawable = withdrawableLocal(item.stream, nowSec);

    let progress = 0;
    const { startTime, endTime } = item.stream;
    if (nowSec >= startTime) {
      if (endTime === 0) {
        progress = 0.5; // open-ended active
      } else if (nowSec >= endTime) {
        progress = 1.0;
      } else {
        progress = (nowSec - startTime) / (endTime - startTime);
      }
    }

    const computedAt = nowSec;

    if (this.enableOptimization) {
      if (this.cache.size >= this.cacheSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }
      this.cache.set(cacheKey, { withdrawable, progress, computedAt });
    }

    this.missExecutionTimeMs += performance.now() - start;

    return {
      id: item.id,
      withdrawable,
      progress,
      isCached: false,
      computedAt,
    };
  }

  /**
   * High-performance fast calculation of stream yields over arbitrary durations.
   */
  public computeOptimizedYield(ratePerSecond: bigint, durationSecs: number): bigint {
    if (durationSecs <= 0 || ratePerSecond <= 0n) return 0n;
    return ratePerSecond * BigInt(durationSecs);
  }

  /**
   * Reset performance cache and internal state.
   */
  public clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalProcessed = 0;
    this.totalExecutionTimeMs = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  /**
   * Retrieve performance metrics, including a measured (not assumed) cache speedup.
   */
  public getPerformanceMetrics(): Module48Metrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return {
      totalProcessed: this.totalProcessed,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs: this.totalProcessed > 0 ? this.totalExecutionTimeMs / this.totalProcessed : 0,
    };
  }
}
