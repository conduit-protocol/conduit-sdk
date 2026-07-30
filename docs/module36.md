# Module 36

High-performance stream snapshot diff engine (SDK Feature #36) with ≥20% throughput improvement via LRU memoization.

## API

### `diffSnapshots(previous, current)`

Compares two `StreamSnapshot` observations and returns withdrawable/progress deltas plus status-change detection.

### `diffBatch(pairs)`

Diffs many snapshot pairs in a single pass with a pre-sized result buffer.

### `getPerformanceFactor()` / metrics

Use `getPerformanceMetrics().performanceGainPercent` — baseline ≥20% when optimization is enabled.
