/**
 * Framework-agnostic state model for the Transaction History view.
 *
 * ## Why this module exists (#136 / #103)
 *
 * The Transaction History component crashed immediately on render because its
 * state hook read variables that were never initialised:
 *
 * ```ts
 * // BROKEN — `transactions` and `filters` are `undefined` on first render
 * const [state, setState] = useState<HistoryState>();
 * ...
 * state.transactions.map(...)          // TypeError: Cannot read properties of
 *                                      // undefined (reading 'map')
 * ```
 *
 * Two distinct undefined-variable hazards were involved:
 *
 * 1. **Undefined initial state.** `useState()` / `useReducer(reducer)` invoked
 *    without an initial value yields `undefined` on the very first render, so
 *    every property access in the render body throws before the data ever
 *    arrives from the indexer.
 * 2. **Undefined payloads from the network.** Even with an initial value, the
 *    GraphQL response may be `undefined` (in-flight, aborted by the 15s
 *    timeout, or an `errorPolicy: 'all'` partial response), and individual
 *    records may be missing `amount`, `counterparty`, `status`, etc.
 *
 * Both classes of failure are eliminated here rather than in the React layer:
 * the state shape is *always* fully populated, every reducer transition is
 * total (unknown actions return the previous state unchanged), and every
 * selector is defensive about `null` / `undefined` / wrong-typed input. The
 * React component is then a thin, crash-proof projection of this state.
 *
 * Keeping the logic outside the component also makes it testable in the SDK's
 * Node-based vitest suite — `examples/dashboard` has no test runner and the
 * root package has no React dependency (see the note on the reverted
 * `token-selector-rendering.test.ts` in #159).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a single transaction row. */
export type TransactionStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** Direction of value flow relative to the connected wallet. */
export type TransactionDirection = 'IN' | 'OUT' | 'UNKNOWN';

/** Transaction kinds surfaced by the indexer. */
export type TransactionKind =
  | 'CREATE'
  | 'WITHDRAW'
  | 'PAUSE'
  | 'RESUME'
  | 'CANCEL'
  | 'TOP_UP'
  | 'UNKNOWN';

/**
 * A normalised transaction record. Every field is non-optional: normalisation
 * substitutes safe defaults so the render layer never has to null-check.
 */
export interface TransactionRecord {
  id: string;
  hash: string;
  streamId: string;
  kind: TransactionKind;
  direction: TransactionDirection;
  status: TransactionStatus;
  /** Amount in stroops, kept as a string to avoid precision loss. */
  amount: string;
  asset: string;
  counterparty: string;
  /** Unix epoch milliseconds. `0` when the indexer omitted a timestamp. */
  timestamp: number;
}

/** User-controlled filters applied client-side to the fetched page. */
export interface TransactionFilters {
  status: TransactionStatus | 'ALL';
  kind: TransactionKind | 'ALL';
  direction: TransactionDirection | 'ALL';
  /** Free-text match against hash, stream id, counterparty and asset. */
  search: string;
}

/** Complete Transaction History state. Never `undefined`, never partial. */
export interface TransactionHistoryState {
  transactions: TransactionRecord[];
  filters: TransactionFilters;
  page: number;
  pageSize: number;
  loading: boolean;
  /** Human-readable error message, or `null` when there is no error. */
  error: string | null;
  /** Epoch ms of the last successful load; `0` before the first success. */
  lastUpdated: number;
}

export type TransactionHistoryAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; payload: unknown; receivedAt?: number }
  | { type: 'LOAD_FAILURE'; error: unknown }
  | { type: 'SET_FILTER'; filter: Partial<TransactionFilters> }
  | { type: 'SET_PAGE'; page: unknown }
  | { type: 'SET_PAGE_SIZE'; pageSize: unknown }
  | { type: 'RESET' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 10;

export const INITIAL_TRANSACTION_FILTERS: Readonly<TransactionFilters> =
  Object.freeze({
    status: 'ALL',
    kind: 'ALL',
    direction: 'ALL',
    search: '',
  });

/**
 * The single source of truth for the initial state.
 *
 * Passing this to `useReducer` (or `useState`) is what prevents the
 * first-render crash: `state.transactions` is an array from the very first
 * paint, before any network response exists.
 */
export function createInitialTransactionHistoryState(
  overrides: Partial<TransactionHistoryState> = {},
): TransactionHistoryState {
  const base: TransactionHistoryState = {
    transactions: [],
    filters: { ...INITIAL_TRANSACTION_FILTERS },
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    loading: false,
    error: null,
    lastUpdated: 0,
  };

  const merged: TransactionHistoryState = {
    ...base,
    ...overrides,
    // Guard the two nested/array members against explicit `null` overrides.
    transactions: Array.isArray(overrides.transactions)
      ? overrides.transactions
      : base.transactions,
    filters: { ...base.filters, ...(overrides.filters ?? {}) },
  };

  return merged;
}

const VALID_STATUSES: readonly TransactionStatus[] = [
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
];

const VALID_KINDS: readonly TransactionKind[] = [
  'CREATE',
  'WITHDRAW',
  'PAUSE',
  'RESUME',
  'CANCEL',
  'TOP_UP',
  'UNKNOWN',
];

const VALID_DIRECTIONS: readonly TransactionDirection[] = [
  'IN',
  'OUT',
  'UNKNOWN',
];

// ---------------------------------------------------------------------------
// Coercion helpers — all total functions, never throw
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return fallback;
}

function asTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Indexers emit seconds for `createdAt`; normalise to milliseconds.
    return value < 1e12 ? Math.trunc(value) * 1000 : Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return asTimestamp(numeric);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? 0 : time;
  }
  return 0;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== 'string') return fallback;
  const upper = value.trim().toUpperCase();
  return (allowed as readonly string[]).includes(upper) ? (upper as T) : fallback;
}

/** Extracts a readable message from anything that was thrown or returned. */
export function toErrorMessage(
  error: unknown,
  fallback = 'Failed to load transaction history.',
): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Turns one raw indexer record into a fully-populated `TransactionRecord`.
 * Returns `null` for values that cannot possibly be a record (`null`,
 * primitives, arrays) so the caller can drop them.
 */
export function normalizeTransaction(raw: unknown): TransactionRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;

  const id = asString(record['id'] ?? record['hash'] ?? record['streamId']);
  const hash = asString(record['hash'] ?? record['txHash'] ?? record['id']);

  // A record with no identity at all is unusable — drop it rather than
  // rendering a row with an empty React key.
  if (id === '' && hash === '') return null;

  const amountRaw = record['amount'] ?? record['value'] ?? record['ratePerSecond'];

  return {
    id: id === '' ? hash : id,
    hash,
    streamId: asString(record['streamId'] ?? record['stream_id']),
    kind: asEnum(record['kind'] ?? record['type'], VALID_KINDS, 'UNKNOWN'),
    direction: asEnum(record['direction'], VALID_DIRECTIONS, 'UNKNOWN'),
    status: asEnum(record['status'], VALID_STATUSES, 'UNKNOWN'),
    amount: asString(amountRaw, '0'),
    asset: asString(record['asset'] ?? record['token'] ?? record['symbol'], 'XLM'),
    counterparty: asString(
      record['counterparty'] ?? record['recipient'] ?? record['sender'],
    ),
    timestamp: asTimestamp(record['timestamp'] ?? record['createdAt']),
  };
}

/**
 * Normalises a whole payload. Accepts the raw GraphQL `data` object, a bare
 * array, `null`, `undefined` or garbage — and always returns an array.
 */
export function normalizeTransactions(payload: unknown): TransactionRecord[] {
  let list: unknown = payload;

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const container = payload as Record<string, unknown>;
    list =
      container['transactions'] ??
      container['transactionHistory'] ??
      container['streams'] ??
      container['items'] ??
      container['data'] ??
      // Support the relay-style `{ edges: [{ node }] }` shape.
      (Array.isArray(container['edges'])
        ? (container['edges'] as unknown[]).map((edge) =>
            edge && typeof edge === 'object'
              ? (edge as Record<string, unknown>)['node']
              : edge,
          )
        : undefined);
  }

  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const normalized: TransactionRecord[] = [];

  for (const entry of list) {
    const record = normalizeTransaction(entry);
    if (record === null) continue;
    // De-duplicate on id so a refetch racing a poll cannot produce duplicate
    // React keys.
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    normalized.push(record);
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function clampPage(page: unknown, totalPages: number): number {
  const numeric = typeof page === 'number' ? page : Number(page);
  if (!Number.isFinite(numeric)) return 0;
  const floored = Math.trunc(numeric);
  if (floored < 0) return 0;
  const maxPage = Math.max(0, totalPages - 1);
  return floored > maxPage ? maxPage : floored;
}

/**
 * Total reducer: every action returns a complete state object, and an
 * unrecognised action (or an `undefined` state from a hot reload / persisted
 * store) falls back to a valid state instead of propagating `undefined`.
 */
export function transactionHistoryReducer(
  state: TransactionHistoryState | undefined,
  action: TransactionHistoryAction | undefined,
): TransactionHistoryState {
  const current = state ?? createInitialTransactionHistoryState();

  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    return current;
  }

  switch (action.type) {
    case 'LOAD_START':
      // Keep the existing rows visible while refreshing so the table does not
      // flash empty; clear the previous error.
      return { ...current, loading: true, error: null };

    case 'LOAD_SUCCESS': {
      const transactions = normalizeTransactions(action.payload);
      const totalPages = Math.max(
        1,
        Math.ceil(transactions.length / Math.max(1, current.pageSize)),
      );
      return {
        ...current,
        transactions,
        loading: false,
        error: null,
        page: clampPage(current.page, totalPages),
        lastUpdated:
          typeof action.receivedAt === 'number' && Number.isFinite(action.receivedAt)
            ? action.receivedAt
            : Date.now(),
      };
    }

    case 'LOAD_FAILURE':
      // Preserve any previously loaded rows: a failed refresh should degrade
      // to "stale data + error banner", never to a crash or a blank screen.
      return {
        ...current,
        loading: false,
        error: toErrorMessage(action.error),
      };

    case 'SET_FILTER': {
      const raw = action.filter ?? {};
      const validated: Partial<TransactionFilters> = {};

      if (raw.status !== undefined) {
        validated.status = asEnum(raw.status, VALID_STATUSES, 'ALL') as TransactionStatus | 'ALL';
      }
      if (raw.kind !== undefined) {
        validated.kind = asEnum(raw.kind, VALID_KINDS, 'ALL') as TransactionKind | 'ALL';
      }
      if (raw.direction !== undefined) {
        validated.direction = asEnum(raw.direction, VALID_DIRECTIONS, 'ALL') as TransactionDirection | 'ALL';
      }
      if (raw.search !== undefined) {
        validated.search = asString(raw.search);
      }

      return {
        ...current,
        filters: { ...current.filters, ...validated },
        // Any filter change invalidates the current page offset.
        page: 0,
      };
    }

    case 'SET_PAGE': {
      const visible = selectFilteredTransactions(current);
      const totalPages = Math.max(
        1,
        Math.ceil(visible.length / Math.max(1, current.pageSize)),
      );
      return { ...current, page: clampPage(action.page, totalPages) };
    }

    case 'SET_PAGE_SIZE': {
      const numeric =
        typeof action.pageSize === 'number'
          ? action.pageSize
          : Number(action.pageSize);
      const pageSize =
        Number.isFinite(numeric) && numeric > 0
          ? Math.trunc(numeric)
          : DEFAULT_PAGE_SIZE;
      return { ...current, pageSize, page: 0 };
    }

    case 'RESET':
      return createInitialTransactionHistoryState();

    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Memoisation for the filter/sort pipeline (#43).
 *
 * A single dashboard render calls `selectViewStatus`, `selectTotalPages` and
 * `selectVisibleTransactions`, and the reducer calls the filter again on every
 * `SET_PAGE` — so the naive implementation walked the whole page of rows four
 * times per interaction and re-sorted it on every page step.
 *
 * The cache is keyed on the identity of `state.transactions` (not on the state
 * object) because pagination and page-size changes produce a *new state* that
 * reuses the *same* rows array — so paging through a loaded page is now pure
 * cache hits with no filter and no sort. A new indexer payload allocates a new
 * array via `normalizeTransactions`, which misses the cache and recomputes;
 * a filter change is caught by the signature check. `WeakMap` keeps entries
 * collectable as soon as the rows array is dropped.
 *
 * This assumes records are treated as immutable, which holds throughout this
 * module: the reducer never mutates state and normalisation always allocates
 * fresh records. Mutating a record in place would serve a stale projection.
 */
interface SelectorCacheEntry {
  signature: string;
  filtered: TransactionRecord[];
  /** Sorted copy, computed lazily — only `selectVisibleTransactions` needs it. */
  sorted: TransactionRecord[] | null;
}

const NO_TRANSACTIONS: readonly TransactionRecord[] = Object.freeze([]);

const selectorCache = new WeakMap<readonly TransactionRecord[], SelectorCacheEntry>();

function selectorEntry(
  state: TransactionHistoryState | undefined,
): SelectorCacheEntry {
  const transactions: readonly TransactionRecord[] = Array.isArray(state?.transactions)
    ? state.transactions
    : NO_TRANSACTIONS;
  const filters = { ...INITIAL_TRANSACTION_FILTERS, ...(state?.filters ?? {}) };
  const search = asString(filters.search).trim().toLowerCase();
  const signature = `${filters.status} ${filters.kind} ${filters.direction} ${search}`;

  const cached = selectorCache.get(transactions);
  if (cached !== undefined && cached.signature === signature) return cached;

  const filtered = transactions.filter((tx) => {
    if (!tx) return false;
    if (filters.status !== 'ALL' && tx.status !== filters.status) return false;
    if (filters.kind !== 'ALL' && tx.kind !== filters.kind) return false;
    if (filters.direction !== 'ALL' && tx.direction !== filters.direction) {
      return false;
    }
    if (search === '') return true;

    return [tx.hash, tx.streamId, tx.counterparty, tx.asset].some((field) =>
      asString(field).toLowerCase().includes(search),
    );
  });

  const entry: SelectorCacheEntry = { signature, filtered, sorted: null };
  selectorCache.set(transactions, entry);
  return entry;
}

/** Applies the active filters. Safe against a malformed/absent state. */
export function selectFilteredTransactions(
  state: TransactionHistoryState | undefined,
): TransactionRecord[] {
  return selectorEntry(state).filtered;
}

/** Filtered rows, newest first, sliced to the current page. */
export function selectVisibleTransactions(
  state: TransactionHistoryState | undefined,
): TransactionRecord[] {
  const entry = selectorEntry(state);
  const sorted =
    entry.sorted ??
    (entry.sorted = [...entry.filtered].sort((a, b) => b.timestamp - a.timestamp));

  const pageSize = Math.max(1, Math.trunc(state?.pageSize ?? DEFAULT_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = clampPage(state?.page ?? 0, totalPages);
  const start = page * pageSize;

  return sorted.slice(start, start + pageSize);
}

/** Total number of pages for the current filters (always >= 1). */
export function selectTotalPages(
  state: TransactionHistoryState | undefined,
): number {
  const filtered = selectorEntry(state).filtered;
  const pageSize = Math.max(1, Math.trunc(state?.pageSize ?? DEFAULT_PAGE_SIZE));
  return Math.max(1, Math.ceil(filtered.length / pageSize));
}

/**
 * Which of the mutually exclusive UI states the view should render.
 * Centralised so the component cannot accidentally render a data table with
 * no data (the original crash path).
 */
export function selectViewStatus(
  state: TransactionHistoryState | undefined,
): 'loading' | 'error' | 'empty' | 'ready' {
  const current = state ?? createInitialTransactionHistoryState();
  const hasRows = selectFilteredTransactions(current).length > 0;

  if (current.loading && !hasRows) return 'loading';
  if (current.error !== null && !hasRows) return 'error';
  if (!hasRows) return 'empty';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Display formatters
// ---------------------------------------------------------------------------

/** `GABC…WXYZ` — never throws on short, empty or non-string input. */
export function formatAddress(address: unknown, visible = 6): string {
  const value = asString(address);
  if (value === '') return '—';
  const head = Math.max(2, Math.trunc(visible));
  if (value.length <= head + 4 + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-4)}`;
}

/** Stroops → decimal string. Falls back to `'0'` on unparseable input. */
export function formatAmount(amount: unknown, decimals = 7): string {
  const raw = asString(amount, '0').trim();
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).replace(/[^0-9]/g, '');
  if (digits === '') return '0';

  const places = Math.max(0, Math.trunc(decimals));
  const padded = digits.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places) || '0';
  const fraction = places === 0 ? '' : padded.slice(padded.length - places);
  const trimmedFraction = fraction.replace(/0+$/, '');

  const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : '';

  return trimmedFraction === ''
    ? `${sign}${formattedWhole}`
    : `${sign}${formattedWhole}.${trimmedFraction}`;
}

/** ISO-ish timestamp for display; `'—'` when the indexer omitted one. */
export function formatTimestamp(timestamp: unknown): string {
  const ms = asTimestamp(timestamp);
  if (ms === 0) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
