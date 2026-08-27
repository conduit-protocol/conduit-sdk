/**
 * Generic LRU cache with hit/miss timing instrumentation.
 *
 * Shared by the memoized stream-analytics modules (`Module26`, `Module36`,
 * `Module48`) so the eviction and speedup-measurement logic lives in one
 * place instead of being re-implemented identically in each of them.
 */

export interface MemoCacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  /**
   * `(avgMissMs - avgHitMs) / avgMissMs * 100`, measured from this
   * instance's own accumulated hit/miss timings — not a fixed assumption.
   * `null` until at least one hit and one miss have both been recorded.
   */
  measuredSpeedupPercent: number | null;
}

export class LruMemoCache<K, V> {
  private readonly store = new Map<K, V>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.store.size;
  }

  /** Look up a key, refreshing its LRU position on hit. */
  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value !== undefined) {
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  /** Insert a key, evicting the least-recently-used entry if at capacity. */
  set(key: K, value: V): void {
    if (!this.store.has(key) && this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }

  recordHit(elapsedMs: number): void {
    this.cacheHits++;
    this.hitExecutionTimeMs += elapsedMs;
  }

  recordMiss(elapsedMs: number): void {
    this.cacheMisses++;
    this.missExecutionTimeMs += elapsedMs;
  }

  clear(): void {
    this.store.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  metrics(): MemoCacheMetrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return { cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, measuredSpeedupPercent };
  }
}
