import type { StreamInfo } from './types/index.js';
import { withdrawableLocal } from './utils.js';

export interface Module26Config {
  /** Maximum number of portfolio summaries retained in the LRU cache */
  cacheSize?: number;
  /** Enable memoized aggregation; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
  /** Preferred chunk size when scanning large stream portfolios */
  batchChunkSize?: number;
}

export interface PortfolioStreamItem {
  id: string;
  stream: StreamInfo;
  /** Observation timestamp (unix seconds) */
  timestamp?: number;
}

export interface PortfolioSummary {
  totalWithdrawable: bigint;
  totalRatePerSecond: bigint;
  activeCount: number;
  pausedCount: number;
  cancelledCount: number;
  endedCount: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module26Metrics {
  totalAggregations: number;
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

function classifyStream(stream: StreamInfo, nowSec: number): 'active' | 'paused' | 'cancelled' | 'ended' {
  if (stream.cancelled) return 'cancelled';
  if (stream.paused) return 'paused';
  if (stream.endTime > 0 && nowSec >= stream.endTime) return 'ended';
  return 'active';
}

/**
 * Module 26: stream portfolio aggregator.
 *
 * Implements Feature #26 with LRU-memoized portfolio summaries. Speedup
 * from caching is workload-dependent (proportional to cache hit rate);
 * call `getPerformanceMetrics()` for this instance's own measured hit/miss
 * timing rather than assuming a fixed percentage.
 */
export class Module26 {
  private readonly cacheSize: number;
  private readonly enableOptimization: boolean;
  private readonly batchChunkSize: number;

  private cache = new Map<string, PortfolioSummary>();
  private totalAggregations = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalExecutionTimeMs = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;

  constructor(config: Module26Config = {}) {
    this.cacheSize = config.cacheSize ?? 1000;
    this.enableOptimization = config.enableOptimization ?? true;
    this.batchChunkSize = config.batchChunkSize ?? 50;
  }

  /**
   * Aggregate a portfolio of streams into totals and lifecycle counts.
   */
  public aggregatePortfolio(items: PortfolioStreamItem[], nowSec = Math.floor(Date.now() / 1000)): PortfolioSummary {
    const start = performance.now();
    const cacheKey = items
      .map((item) => {
        const ts = item.timestamp ?? nowSec;
        return `${item.id}:${item.stream.withdrawn}:${item.stream.paused ? 1 : 0}:${item.stream.cancelled ? 1 : 0}:${item.stream.endTime}:${ts}`;
      })
      .join('|');

    if (this.enableOptimization) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cacheHits++;
        this.totalAggregations++;
        this.totalExecutionTimeMs += elapsed;
        this.hitExecutionTimeMs += elapsed;
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return { ...cached, isCached: true };
      }
    }

    this.cacheMisses++;

    let totalWithdrawable = 0n;
    let totalRatePerSecond = 0n;
    let activeCount = 0;
    let pausedCount = 0;
    let cancelledCount = 0;
    let endedCount = 0;

    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunkEnd = Math.min(i + this.batchChunkSize, items.length);
      for (let j = i; j < chunkEnd; j++) {
        const item = items[j];
        if (!item) continue;
        const ts = item.timestamp ?? nowSec;
        totalWithdrawable += withdrawableLocal(item.stream, ts);
        const status = classifyStream(item.stream, ts);
        if (status === 'active') {
          activeCount++;
          totalRatePerSecond += item.stream.ratePerSecond;
        } else if (status === 'paused') {
          pausedCount++;
        } else if (status === 'cancelled') {
          cancelledCount++;
        } else {
          endedCount++;
        }
      }
    }

    const summary: PortfolioSummary = {
      totalWithdrawable,
      totalRatePerSecond,
      activeCount,
      pausedCount,
      cancelledCount,
      endedCount,
      isCached: false,
      computedAt: nowSec,
    };

    if (this.enableOptimization) {
      if (this.cache.size >= this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, summary);
    }

    const elapsed = performance.now() - start;
    this.totalAggregations++;
    this.totalExecutionTimeMs += elapsed;
    this.missExecutionTimeMs += elapsed;
    return summary;
  }

  /**
   * Project remaining streamable amount for an active stream over a horizon.
   */
  public projectRemaining(stream: StreamInfo, horizonSecs: number, nowSec = Math.floor(Date.now() / 1000)): bigint {
    if (horizonSecs <= 0 || stream.cancelled || stream.paused) return 0n;
    if (stream.endTime > 0 && nowSec >= stream.endTime) return 0n;

    const effectiveEnd =
      stream.endTime > 0 ? Math.min(stream.endTime, nowSec + horizonSecs) : nowSec + horizonSecs;
    if (effectiveEnd <= nowSec) return 0n;
    return stream.ratePerSecond * BigInt(effectiveEnd - nowSec);
  }

  public clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalAggregations = 0;
    this.totalExecutionTimeMs = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  public getPerformanceMetrics(): Module26Metrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return {
      totalAggregations: this.totalAggregations,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs:
        this.totalAggregations > 0 ? this.totalExecutionTimeMs / this.totalAggregations : 0,
    };
  }
}
