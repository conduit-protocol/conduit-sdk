# Architecture

Module map and call flow for `conduit-sdk`. For the full method-by-method reference, see
[`docs/api.md`](./api.md).

---

## Module map

```
index.ts          — public exports: ConduitClient, ConduitError/ErrorCode, types, utils
client.ts         — ConduitClient: owns config, instantiates the three modules below
  ├─ streams.ts    — StreamsModule:  create/get/withdraw/cancel/pause/resume/topUp/clawback/list/subscribe
  ├─ factory.ts    — FactoryModule:  streamCount/streamAddress/streamsBySender/streamsByRecipient/protocolFeeBps
  └─ governor.ts   — GovernorModule: (config reads — see docs/api.md)
soroban.ts         — buildContractCallTx/simulateReadOnly/getServer/clearServerCache + NETWORK_PASSPHRASE/DEFAULT_RPC tables
                      (getServer maintains a module-level cache of SorobanRpc.Server instances keyed by URL,
                      eliminating per-call HTTP agent creation; used internally by all RPC-calling code paths)
events.ts          — subscribeToStream: polls getEvents(), dispatches to typed handlers
errors.ts          — ConduitError + ErrorCode, mapped from on-chain contract error codes
utils.ts           — toStroops/fromStroops/calculateRate/streamProgress/withdrawableLocal (pure, no RPC)
indexer.ts         — GraphQLIndexer: query() + subscribe() (WebSocket, SSE fallback) against the indexer
dashboard/transaction-history.ts
                   — framework-agnostic reducer + selectors for the Transaction History view
                      (normalisation, filtering, sorting, pagination — see "Selector memoisation" below)
contracts/*-abi.ts — generated-style ABI/method-name constants per contract
```

`ConduitClient` is a thin composition root — it resolves the RPC URL (`config.rpcUrl ??
DEFAULT_RPC[network]`) and hands the same config to `StreamsModule`, `FactoryModule`, and
`GovernorModule`. Each module is otherwise independent; there's no shared mutable state between
them beyond that config object.

---

## Call flow (mutating action)

```
client.streams.withdraw(streamId, amount?)
  │
  ├─ resolves streamId → stream contract address, via FactoryModule.streamAddress()
  ├─ if amount omitted: calls withdrawable() first to get the full balance
  ├─ builds the contract-call transaction (soroban.ts: buildContractCallTx)
  ├─ simulates it against the configured RPC
  ├─ signs with config.keypair
  ├─ submits, then polls for the transaction result
  └─ throws ConduitError (mapped from the contract's numeric Error code) on failure
```

Read-only calls (`get`, `withdrawable`, `streamCount`, ...) stop after simulation — no signing or
submission, no `keypair` required.

---

## Errors

`errors.ts` maps each contract's numeric `Error` code to a `ConduitError` with a symbolic
`ErrorCode`. Because `DripStream`, `DripFactory`, and `DripGovernor` each define their **own**
`Error` enum on the Rust side (code `1` means something different in each), the mapping is
contract-aware — check which module raised the error, not just the numeric code, if you're
reading raw Soroban errors instead of going through this SDK.

---

## Events — read the caveat before relying on payload fields

`events.ts` polls `SorobanRpc.Server.getEvents()` and dispatches by topic name. As of this
version, only the `amount` field (for `onWithdraw`/`onClawback`) is actually decoded from the
event's XDR value — every other numeric field on the other handlers (`onCancel`, `onPause`,
`onResume`, `onTopUp`) is a hardcoded `0`/`0n` placeholder, because the underlying contract
events publish multi-value tuples and the parser only handles the single-value case so far. See
[`docs/api.md`](./api.md#subscribestreamid-handlers--subscription) for the full list of affected
fields. Treat these events as a "something changed, go refetch" signal rather than a source of
truth, until tuple decoding is implemented.

---

## Selector memoisation (`dashboard/transaction-history.ts`)

The Transaction History selectors are pure projections of state, and a single render reads
several of them:

```
selectViewStatus(state)          → needs the filtered rows
selectTotalPages(state)          → needs the filtered rows
selectVisibleTransactions(state) → needs the filtered rows, sorted, then sliced
transactionHistoryReducer(SET_PAGE) → needs the filtered rows again, to clamp the page
```

Each of those used to re-run the full predicate over every loaded row, and `SET_PAGE` re-sorted
the entire filtered set just to slice out ten rows. For a 200-row page that's four filter passes
plus a fresh `O(n log n)` sort per pagination click.

`selectFilteredTransactions` now memoises through a module-level `WeakMap` keyed on the identity
of `state.transactions`, with the active filters serialised into a signature that invalidates the
entry when the filters change. The sorted copy is stored on the same entry and computed lazily,
so only `selectVisibleTransactions` pays for it, and only once per (rows, filters) pair.

The key is the **rows array**, not the state object, and that is what makes paging cheap:
`SET_PAGE` / `SET_PAGE_SIZE` return a new state that reuses the same rows array, so every
selector after a page change is a cache hit — no filter, no sort. `LOAD_SUCCESS` allocates a new
array in `normalizeTransactions` and therefore correctly misses the cache.

Net effect for a typical render of a loaded page: **one** filter pass instead of four, and one
sort instead of one per page change — comfortably past the 20% target, and the gap widens with
row count. `WeakMap` means the cache holds no strong reference to dropped payloads.

**Invariant this relies on:** records are immutable. The reducer never mutates state in place and
normalisation always allocates fresh records, so this holds inside the SDK. If you mutate a
`TransactionRecord` in place, the selectors will serve the previous projection — build a new
array instead.

---

## What's *not* wrapped yet

`DripStream::force_cancel`, `transfer_recipient`, and `streamed_total` exist on the contract
(see `conduit-contracts`) but have no corresponding methods on `StreamsModule` yet.
