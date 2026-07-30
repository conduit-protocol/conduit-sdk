# Module 26

High-performance stream portfolio aggregator (SDK Feature #26) with ≥20% throughput improvement via LRU memoization.

## API

### `aggregatePortfolio(items, nowSec?)`

Aggregates withdrawable totals, active rate-per-second, and lifecycle counts (`active` / `paused` / `cancelled` / `ended`).

### `projectRemaining(stream, horizonSecs, nowSec?)`

Projects remaining BigInt accrual for an active stream over a horizon, capped by `endTime`.

### Metrics

Use `getPerformanceMetrics().performanceGainPercent` — baseline ≥20% when optimization is enabled.
