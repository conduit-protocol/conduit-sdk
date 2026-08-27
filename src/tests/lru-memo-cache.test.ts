import { describe, it, expect } from 'vitest';
import { LruMemoCache } from '../lru-memo-cache.js';

describe('LruMemoCache', () => {
  it('stores and retrieves values by key', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once at capacity', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes LRU order on read, protecting recently-accessed entries from eviction', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' so 'b' becomes the oldest
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('reports null speedup until at least one hit and one miss are recorded', () => {
    const cache = new LruMemoCache<string, number>(10);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordMiss(5);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordHit(1);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(1);
    expect(metrics.cacheMisses).toBe(1);
    expect(metrics.measuredSpeedupPercent).toBeCloseTo(80); // (5 - 1) / 5 * 100
  });

  it('resets storage and counters on clear', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    cache.recordHit(1);
    cache.recordMiss(2);

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(0);
    expect(metrics.cacheMisses).toBe(0);
    expect(metrics.measuredSpeedupPercent).toBeNull();
  });
});
