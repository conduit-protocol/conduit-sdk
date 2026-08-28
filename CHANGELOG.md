# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `StreamsModule.streamedTotal()` — read-only wrapper for `DripStream::streamed_total`, exposing the cumulative amount streamed since start regardless of withdrawals (#455)
- `StreamsModule.estimateFee(operation)` runs a Soroban simulation for any stream operation and returns the exact estimated network fee (`FeeEstimate` with `totalFee`, `resourceFee`, `baseFee`, `instructions`) so the UI can display the fee before the user clicks "Create Stream".
- `Module36` stream snapshot diff engine with LRU memoization for Feature #36 (#370); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage
- `Module26` stream portfolio aggregator with LRU memoization for Feature #26 (#360); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage
- Direct unit tests closing the `src/soroban.ts` test gaps: `queryXlmBalance()` (mocked `simulateTransaction` responses, incl. the error path) and `estimateRequiredFee()` (fallback value + `minResourceFee`/`fee` extraction shapes) (#460, #461)
- Direct unit tests for `resolvePassphrase()` covering explicit passphrase present/blank, named network known/unknown, and neither-provided branches (#462)
- `StreamsModule.forceCancel()` — wraps the contract's `force_cancel()` so a recipient can force-cancel a stream paused beyond the 30-day threshold (previously only a prose TODO; `StreamErrorCode.PauseThresholdNotMet` is now reachable through the SDK) (#453)
- `StreamsModule.transferRecipient()` — wraps the contract's `transfer_recipient()` so the current recipient can reassign the recipient role (previously only a prose TODO) (#454)

### Performance
- `FactoryModule.streamAddress()` now caches resolved stream→contract-address lookups in-memory, since the mapping is fixed at stream creation and never changes. Eliminates redundant RPC round trips on every `StreamsModule` read/write operation (`get`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`) and on each page of `list()`, which previously re-resolved the same address for every stream on every call.
- `buildBatchTransactions()` (the RPC-prepared batch path) now simulates all operations in a batch concurrently instead of one at a time, cutting the wall-clock time of an N-operation batch from N sequential RPC round trips to one.

### Removed
- Removed orphaned `RoomManager` (`src/room-manager.js`) and `src/server.js` WebSocket server, along with unused `dotenv` production dependency (#442).
- Removed unused `GraphSyncAgent` (`src/graph-sync-agent.ts`) dead code (#443).
- Removed dead `Module46` string-normalization wrapper (`src/module46.ts`) — never exported from `src/index.ts` and unreferenced elsewhere (#478).

### Documentation
- Removed non-existent `contracts/*-abi.ts` entry from `docs/architecture.md` module map (#440).
- Replaced orphaned `MAX_ROOM_SIZE` `.env.example` with a comprehensive SDK environment configuration template and updated `README.md` (#441).
- Added an API reference section for `GraphQLIndexer`, which was previously exported but undocumented.
- Added a "Wallet Adapters" API reference section documenting `KeypairWalletAdapter`.
- Documented `StreamBuilder.ratePerSecond()` and `StreamBuilder.submit()` (with full `SubmitOptions`) in `docs/api.md`, previously omitted from the Fluent Builder reference (#463).
- Documented `ConduitClient`'s `pauseStream()`, `unpauseStream()`, and `setWallet()` convenience methods in `docs/api.md`, and fixed `setWallet()`'s JSDoc block, which had been orphaned above `pauseStream()`/`unpauseStream()` and left `setWallet()` itself undocumented.

### Fixed
- `Module26`, `Module36`, `Module48`, and `Module49` now share a single `LruMemoCache` helper (`src/lru-memo-cache.ts`) for eviction (and, for the first three, hit/miss speedup measurement) instead of each re-implementing the same LRU-memoizer logic (#479).
- `Module26.aggregatePortfolio()` now fingerprints the portfolio with two incremental hashes (FNV-1a + djb2) instead of building a full `items.map(...).join('|')` string on every call, including cache hits — for a large portfolio that string could run to many KB and dominated the "cached" path, so `measuredSpeedupPercent` mostly measured string building rather than the aggregation it memoizes. Two independent hashes are combined into the key rather than one, since a single 32-bit hash would make wrong-portfolio cache collisions realistic at long-running-instance scale (#480).
- `Module48.processSingleItem()` now updates `totalProcessed` and the execution-time accumulator on every call, so `getPerformanceMetrics().averageExecutionTimeMs` is accurate whether streams are processed via `processStreamBatch()` or by calling `processSingleItem()` directly; previously only `processStreamBatch()` touched `totalProcessed`, so direct `processSingleItem()` calls always reported `averageExecutionTimeMs: 0` (#481).
- **Breaking:** `RateLimitError.fromRpcError()` no longer conflates HTTP 503 (Service Unavailable) with 429 (Too Many Requests). A 503 is now reported as a distinct exported `RpcServiceUnavailableError`, and the internal RPC retry wrapper only backoff-retries genuine `RateLimitError`s — a 503 fails fast so consumers can fail over to a different RPC URL instead of retrying a dead endpoint (#456).
- `catchNetworkError()` no longer reclassifies *any* `TypeError` whose text happens to contain `fetch`/`connect`/`network`/etc. It now only reclassifies errors that are provably transport failures: the canonical fetch/axios network messages (`fetch failed`, `Failed to fetch`, `Network Error`, `Load failed`) or an error (or its nested `cause`) carrying a network errno code such as `ECONNREFUSED`/`ENOTFOUND`/`ERR_NETWORK`. A programming `TypeError` (e.g. `Cannot read properties of undefined (reading 'connect')`) is re-thrown as-is instead of being masked as a network outage (#457).
- `NonceManager` now throws a descriptive error for an unparseable nonce string (e.g. `startNonce: 'not-a-number'`) instead of silently coercing it to `0n`, which masked caller bugs as an explicit zero (#458).
- `StreamBuilder.build()` now stringifies a numeric `ratePerSecond` so the runtime value matches the declared `ratePerSecond?: string` return type; previously a `number` input passed through unchanged, so callers trusting the type (`.trim()`, string concatenation) hit runtime errors (#459).
- `StreamsModule.withdraw()` / `topUp()` now reject `amount <= 0n` client-side (before any RPC round-trip), matching `create()`'s fail-fast validation philosophy instead of relying on the contract's `InvalidAmount` simulate+reject cycle (#451)
- `StreamsModule.list()` no longer silently drops `recipient` when both `sender` and `recipient` are provided — it now returns the de-duplicated union of both filters (#452)
- **Critical:** `FeeEstimator.estimateFee()` now uses `bigint` stroops instead of floating-point for fee representation, eliminating IEEE-754 precision loss. All monetary amounts in the SDK now consistently use bigint to avoid rounding errors.
- **Critical:** `WalletConnectAdapter.signTransaction()` now requires `networkPassphrase` to be explicitly provided, preventing silently reconstructed Transaction objects with empty passphrases. Throws clear error if passphrase is missing.
- **Critical:** `StreamBuilder.submit()` now properly removes failed payloads from `pendingQueue` in a finally block, preventing queue overflow from accumulated failed submissions under sustained network failures.
- **Breaking:** `ConduitBatcher` state is now instance-based instead of process-wide static singleton. Each `new ConduitBatcher()` instance maintains independent queue and destroy state. Existing code using static methods must be updated to create instances.
- **Critical:** Validation bypass in `ConduitBatcher.execute()` — duplicate method definition allowed invalid payloads to bypass client-side validation. Now enforces mandatory schema validation before submission.
- **Critical:** Unsafe non-null assertions in `WalletConnectAdapter.getPublicKeyFromSession()` — replaced with safe fallback handling using optional chaining and nullish coalescing. Prevents crashes on malformed CAIP-10 formats.
- RPC timeout handling in `WalletConnectAdapter.connect()` — properly clears timeout promise on success to prevent hanging when network drops during handshake.

### Planned
- `@conduit-protocol/react` hooks package (`useStream`, `useWithdraw`, `useStreamList`)
- `StreamsModule.streamedTotal()` wrapping the `streamed_total()` contract function

---

## [0.2.0] - 2026-03-21

### Added
- Full `StreamsModule` implementation: `create`, `get`, `withdrawable`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`, `list`
- `GovernorModule.getConfig()` — fetches and parses `GovernorConfig` ScMap from chain
- `FactoryModule`: `streamCount()`, `streamAddress()`, `streamsBySender()`, `streamsByRecipient()`, `protocolFeeBps()`
- `buildContractCallTx` helper in `soroban.ts` — builds a fee-bumped, sequence-correct Soroban transaction ready for simulation
- `boolToScVal`, `scValToI128`, `scValToU64` conversion utilities
- Unit tests for `FactoryModule` and `StreamsModule` with mocked RPC

### Changed
- `streams.clawback()` now returns the reclaimed amount (`bigint`) rather than the transaction hash — extracted from the simulation retval before submission
- `streams.withdraw()` `amount` parameter is now optional; defaults to the full withdrawable balance via a preliminary `withdrawable()` call

---

## [0.1.0] - 2026-02-28

### Added
- `ConduitClient` with `streams`, `factory`, and `governor` modules
- `ConduitError` class with `fromContractError()` static constructor
- `ErrorCode` enum matching all 12 contract error codes
- `toStroops`, `fromStroops`, `calculateRate`, `streamProgress`, `withdrawableLocal` utilities
- Event subscription via `streams.subscribe()` and `streams.subscribeAsync()` — polls Soroban event ledger
- Type definitions: `StreamInfo`, `CreateStreamParams`, `CreateStreamResult`, `ListStreamsParams`, `GovernorConfig`, all event types
- ESM + CJS dual bundle output via Rollup
- Unit tests for pure utilities and error handling
