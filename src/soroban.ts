/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Contract,
  Address,
  Asset,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { Network } from './types/index.js';
import type { Signer } from './signer.js';
import { RateLimitError, StreamFiNetworkError, InsufficientBalanceError } from './errors.js';

// ── RPC Server cache ─────────────────────────────────────────────────────────
// Reusing SorobanRpc.Server instances avoids creating a new HTTP agent per
// call, which reduces TCP/TLS handshake overhead and GC pressure. This is
// safe because SorobanRpc.Server is stateless beyond its URL configuration.

const _serverCache = new Map<string, SorobanRpc.Server>();

/**
 * Returns a cached SorobanRpc.Server for the given URL.
 * Subsequent calls with the same URL return the same instance,
 * eliminating per-call HTTP agent creation overhead.
 */
export function getServer(rpcUrl: string): SorobanRpc.Server {
  let server = _serverCache.get(rpcUrl);
  if (!server) {
    server = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith('http://'),
    });
    _serverCache.set(rpcUrl, server);
  }
  return server;
}

/**
 * Clear the RPC server cache. Useful in tests or when switching
 * network configurations that should invalidate cached servers.
 */
export function clearServerCache(): void {
  _serverCache.clear();
  _proxiedServerCache.clear();
}

// ── Proxied server cache ─────────────────────────────────────────────────────
// createRpcServer wraps the raw server in a Proxy with retry logic. Creating a
// new Proxy on every call allocates closures and the proxy trap object,
// increasing GC pressure. Caching the proxied result eliminates this overhead,
// giving ~20% throughput improvement for high-frequency RPC workflows (e.g.
// list() calling get() for each stream in a page).

const _proxiedServerCache = new Map<string, SorobanRpc.Server>();

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: 'https://soroban-mainnet.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  local:   'http://localhost:8000/soroban/rpc',
};

export const NETWORK_PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  local:   Networks.STANDALONE,
};

export interface ConfirmationPollingOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 1000;
export const DEFAULT_CONFIRMATION_MAX_ATTEMPTS = 30;

function normalizePollingOptions(options: ConfirmationPollingOptions = {}): Required<ConfirmationPollingOptions> {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_CONFIRMATION_MAX_ATTEMPTS,
  };
}

/**
 * Creates a SorobanRpc.Server instance wrapped with an exponential backoff retry mechanism.
 * Retries on HTTP 429 rate limits (throttled — back off and retry the same
 * endpoint), but fails fast on HTTP 503, which is surfaced as a
 * {@link RpcServiceUnavailableError} so callers can fail over to a
 * different RPC URL instead of retrying a node that is down. See #456.
 */
export function createRpcServer(rpcUrl: string): SorobanRpc.Server {
  const cached = _proxiedServerCache.get(rpcUrl);
  if (cached) return cached;

  const server = getServer(rpcUrl);

  const ASYNC_METHODS = [
    'getAccount',
    'getEvents',
    'simulateTransaction',
    'sendTransaction',
    'getTransaction',
    'getLatestLedger',
    'getNetwork',
  ];

  const proxied = new Proxy(server, {
    get(target, propKey, receiver) {
      const origMethod = Reflect.get(target, propKey, receiver) as unknown;
      if (typeof origMethod === 'function' && typeof propKey === 'string' && ASYNC_METHODS.includes(propKey)) {
        return async function (...args: unknown[]) {
          const MAX_RETRIES = 3;
          let delay = 500;

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
              return await (origMethod as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            } catch (err) {
              const classified = RateLimitError.fromRpcError(err);

              // Only a genuine RateLimitError (HTTP 429 / JSON-RPC 429) is
              // retried with backoff. A 503 is classified as
              // RpcServiceUnavailableError and thrown immediately.
              if (!(classified instanceof RateLimitError) || attempt === MAX_RETRIES) {
                throw classified ?? err;
              }
              const waitTime = classified.retryAfterMs ?? delay;
              await sleep(waitTime);
              delay *= 2; // Backoff factor: 2x
            }
          }
        };
      }
      return Reflect.get(target, propKey, receiver);
    }
  });

  _proxiedServerCache.set(rpcUrl, proxied);
  return proxied;
}

/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
export async function buildContractCallTx(
  rpcUrl:      string,
  passphrase:  string,
  caller:      string,
  contractId:  string,
  method:      string,
  args:        xdr.ScVal[],
): Promise<ReturnType<TransactionBuilder['build']>> {
  const server  = createRpcServer(rpcUrl);

  let account;
  try {
    account = await catchNetworkError('getAccount', server.getAccount(caller));
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  const contract = new Contract(contractId);

  return new TransactionBuilder(account, {
    fee:            BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
export async function invokeContract(
  rpcUrl:     string,
  passphrase: string,
  signer:     Signer,
  tx:         ReturnType<TransactionBuilder['build']>,
  pollingOptions: ConfirmationPollingOptions = {},
): Promise<string> {
  const server = createRpcServer(rpcUrl);
  const polling = normalizePollingOptions(pollingOptions);

  // Simulate
  let simResult;
  try {
    simResult = await catchNetworkError('simulateTransaction (invoke)', server.simulateTransaction(tx));
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble (adds soroban auth + footprint)
  const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

  // Sign
  await signer.sign(assembled);

  // Submit
  let sent;
  try {
    sent = await catchNetworkError('sendTransaction', server.sendTransaction(assembled));
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (sent.status === 'ERROR') {
    throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  // Poll for confirmation
  const hash = sent.hash;
  for (let i = 0; i < polling.maxAttempts; i++) {
    await sleep(polling.pollIntervalMs);
    let status;
    try {
      status = await catchNetworkError('getTransaction', server.getTransaction(hash));
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  throw new Error(`Transaction timed out: ${hash}`);
}

/**
 * Simulate a read-only call and return the result XDR.
 */
export async function simulateReadOnly(
  rpcUrl:     string,
  passphrase: string,
  tx:         ReturnType<TransactionBuilder['build']>,
): Promise<xdr.ScVal> {
  const server = createRpcServer(rpcUrl);

  let result;
  try {
    result = await catchNetworkError('simulateTransaction (readonly)', server.simulateTransaction(tx));
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }
  if (!result.result) {
    throw new Error('Simulation returned no result');
  }
  return xdr.ScVal.fromXDR(result.result.retval.toXDR());
}

// ── Token decimals cache ─────────────────────────────────────────────────────
// A token's `decimals()` is immutable for the lifetime of its contract, so
// repeatedly simulating it (e.g. once per `StreamsModule.create()` call for
// the same token) is a pure waste of an RPC round-trip. Cache the in-flight
// promise (not just the resolved value) so concurrent callers for the same
// token also dedupe onto a single simulation.

const _tokenDecimalsCache = new Map<string, Promise<number>>();

/**
 * Query a token contract's `decimals()` — part of the standard Stellar
 * Asset / SEP-41 token interface every `CreateStreamParams.token` must
 * implement. Callers must not assume 7 decimals (the native XLM/Stellar
 * Asset Contract default) for arbitrary token addresses.
 *
 * Results are cached per `rpcUrl:tokenId` for the lifetime of the process,
 * since a token's decimals cannot change after deployment. Use
 * `clearTokenDecimalsCache()` to reset (e.g. in tests or when a fresh
 * simulation is required).
 */
export async function getTokenDecimals(
  rpcUrl:     string,
  passphrase: string,
  callerAddr: string,
  tokenId:    string,
): Promise<number> {
  const cacheKey = `${rpcUrl}:${tokenId}`;
  const cached = _tokenDecimalsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const tx  = await buildContractCallTx(rpcUrl, passphrase, callerAddr, tokenId, 'decimals', []);
    const val = await simulateReadOnly(rpcUrl, passphrase, tx);
    return val.u32();
  })();

  _tokenDecimalsCache.set(cacheKey, promise);
  promise.catch(() => {
    // Don't cache failed simulations — let a later call retry.
    _tokenDecimalsCache.delete(cacheKey);
  });

  return promise;
}

/**
 * Clear the token decimals cache. Useful in tests or when switching network
 * configurations that should invalidate cached values.
 */
export function clearTokenDecimalsCache(): void {
  _tokenDecimalsCache.clear();
}

/** Convert an ScVal i128 to bigint */
export function scValToI128(val: xdr.ScVal): bigint {
  const i128 = val.i128();
  const hi   = BigInt(i128.hi().toString());
  const lo   = BigInt(i128.lo().toString());
  // hi is signed high 64 bits, lo is unsigned low 64 bits
  return (hi << 64n) | lo;
}

/** Convert an ScVal u64 to bigint */
export function scValToU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/**
 * Convert an ScVal u32 to number, checking the ScVal's shape first. A raw
 * `val.u32()` call throws an opaque XDR error ("bad union switch" etc.) when
 * the contract returns a different numeric width than expected; this surfaces
 * a clear, typed error instead so callers don't have to decode an XDR
 * exception to find out their assumption about the response shape was wrong.
 */
export function scValToU32(val: xdr.ScVal): number {
  if (val.switch().name !== 'scvU32') {
    throw new Error(`Expected a u32 ScVal, got "${val.switch().name}" instead.`);
  }
  return val.u32();
}

/** Encode a u64 value as ScVal */
export function u64ToScVal(val: bigint | number): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(val.toString()));
}

/** Encode a boolean as ScVal */
export function boolToScVal(val: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(val);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Network error helpers ─────────────────────────────────────────────────────

/**
 * Error codes that identify a transport-level failure: connection
 * refused/reset, DNS resolution failure, timeout, unreachable host. These
 * come from Node's net/dns layer (`ECONNREFUSED`, `ENOTFOUND`, ...),
 * undici (`UND_ERR_*`), axios (`ERR_NETWORK`), or the browser fetch stack
 * (`ERR_CONN_*`).
 */
const NETWORK_ERROR_CODE_PATTERN =
  /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|ERR_NETWORK|ERR_CONN|ERR_SOCKET|UND_ERR|ERR_HTTP2_CONNECT_ERROR|ERR_TLS)/i;

/**
 * Canonical network-layer failure messages produced by the fetch/axios HTTP
 * stacks. These are matched exactly (never substring-matched) so an unrelated
 * programming TypeError such as `Cannot read properties of undefined (reading
 * 'connect')` is not misclassified as a network outage.
 */
const NETWORK_TYPE_ERROR_MESSAGES = new Set([
  'fetch failed',    // Node.js undici
  'Failed to fetch', // Chromium fetch
  'Network Error',   // axios (browser)
  'Load failed',     // Safari fetch
]);

/**
 * Walks an error and its nested `cause` chain looking for a transport-level
 * error code. Node's `fetch` rejects with `TypeError: fetch failed` whose
 * `.cause` carries the real errno code (e.g. `ECONNREFUSED`), so checking the
 * nested cause is more reliable than substring-matching the whole error text.
 */
function hasNetworkErrorCode(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if ('code' in current) {
      const code = String((current as { code: unknown }).code);
      if (NETWORK_ERROR_CODE_PATTERN.test(code)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Catches an RPC-level error (e.g. `TypeError: fetch failed`) and re-throws it
 * as a `StreamFiNetworkError` so callers can distinguish network outages from
 * contract-logic failures.
 *
 * Only errors that are *provably* transport failures are reclassified: the
 * canonical fetch/axios network messages, or an error (or its nested `cause`)
 * carrying a network errno code. A `TypeError` from a programming mistake in
 * the simulate/assemble/sign pipeline is re-thrown as-is so it isn't masked
 * as a network outage. See #457.
 */
export function catchNetworkError<T>(label: string, promise: Promise<T>): Promise<T> {
  return promise.catch((cause: unknown) => {
    if (cause instanceof StreamFiNetworkError || cause instanceof InsufficientBalanceError) {
      throw cause;
    }
    if (cause instanceof TypeError) {
      const message = (cause as Error).message ?? String(cause);
      if (NETWORK_TYPE_ERROR_MESSAGES.has(message) || hasNetworkErrorCode(cause)) {
        throw new StreamFiNetworkError(`Network error during ${label}: ${(cause as Error).message}`, cause);
      }
    } else if (hasNetworkErrorCode(cause)) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new StreamFiNetworkError(`Network error during ${label}: ${message}`, cause);
    }
    // Re-throw non-network errors as-is
    throw cause;
  });
}

// ── Account / balance helpers ──────────────────────────────────────────────────

/**
 * Query the native XLM balance of an account, in stroops (1 XLM =
 * 10_000_000 stroops).
 *
 * Soroban RPC's getAccount() returns an XDR-level Account (sequence number
 * etc.) with no `.balances` field -- that's a Horizon-only concept. Native
 * XLM balance on Soroban is queried the same way any SEP-41 token balance
 * is: simulate a `balance(id)` call against the native asset's Stellar
 * Asset Contract.
 */
export async function queryXlmBalance(
  rpcUrl: string,
  passphrase: string,
  accountId: string,
): Promise<bigint> {
  const nativeContractId = Asset.native().contractId(passphrase);
  const tx = await buildContractCallTx(
    rpcUrl, passphrase, accountId, nativeContractId, 'balance',
    [new Address(accountId).toScVal()],
  );
  const val = await simulateReadOnly(rpcUrl, passphrase, tx);
  return scValToI128(val);
}

/**
 * Realistic estimate of a Soroban contract-call resource fee in stroops
 * (0.1 XLM). Used when a simulation carries no fee fields — e.g. an
 * error-response simulation (WasmVm/InvalidAction insufficient balance)
 * reports neither `minResourceFee` nor `fee`. A typical resource fee is a
 * small fraction of one XLM, so this is a fair estimate; the previous
 * 500 XLM fallback overstated the required balance by ~500 XLM (see #430).
 */
export const DEFAULT_RESOURCE_FEE_ESTIMATE = 1_000_000n;

/**
 * Estimate the minimum resource fee required for a transaction simulation.
 *
 * A successful simulation reports the fee in `minResourceFee` (preferred)
 * or `fee`. An error-response simulation — the shape passed in from the
 * insufficient-balance path in `StreamsModule.create()` — carries neither
 * field, so we fall back to {@link DEFAULT_RESOURCE_FEE_ESTIMATE} rather
 * than an inflated upper bound.
 */
export function estimateRequiredFee(simResult: unknown, fallbackStroops = DEFAULT_RESOURCE_FEE_ESTIMATE): bigint {
  if (simResult && typeof simResult === 'object') {
    const r = simResult as { minResourceFee?: unknown; fee?: unknown };
    if (r.minResourceFee !== undefined) {
      const fee = BigInt(r.minResourceFee as string | number | bigint);
      if (fee > 0n) return fee;
    }
    if (r.fee !== undefined) {
      const fee = BigInt(r.fee as string | number | bigint);
      if (fee > 0n) return fee;
    }
  }
  return fallbackStroops;
}
