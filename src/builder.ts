import { StrKey } from '@stellar/stellar-sdk';
import { bigintSafeStringify } from './utils.js';
import {
  buildBatchTransactions,
  buildBatchTransactionsSync,
  validateContext,
} from './batch-tx.js';
import type { BatchTransactionContext, BuiltBatchTransaction } from './batch-tx.js';

export interface SubmitOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  /** Max concurrent in-flight submissions. Default 10. */
  concurrency?: number;
  /** Max pending queue size before backpressure kicks in. Default 100. */
  maxQueueSize?: number;
  /** AbortSignal to cancel the submission while in-flight. */
  signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_MAX_QUEUE_SIZE = 100;

class Semaphore {
  private _running = 0;
  private _queue: Array<() => void> = [];
  private readonly _max: number;

  constructor(max: number) {
    this._max = max;
  }

  async acquire(): Promise<void> {
    if (this._running < this._max) {
      this._running++;
      return;
    }
    return new Promise<void>(resolve => { this._queue.push(resolve); });
  }

  release(): void {
    this._running--;
    if (this._queue.length > 0) {
      this._running++;
      this._queue.shift()!();
    }
  }
}

/** Fluent builder for constructing stream configurations. */
export class StreamBuilder {
  private _token?: string | undefined;
  private _sender?: string | undefined;
  private _recipient?: string | undefined;
  private _amount?: number | undefined;
  private _ratePerSecond?: number | bigint | undefined;

  private pendingQueue: Array<Record<string, unknown>> = [];
  private activeTimers: Set<NodeJS.Timeout> = new Set();
  private isDestroyed = false;
  private _semaphore: Semaphore;
  private _maxQueueSize: number;

  constructor(options?: { concurrency?: number; maxQueueSize?: number }) {
    this._semaphore = new Semaphore(options?.concurrency ?? DEFAULT_CONCURRENCY);
    this._maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /**
   * Sets the token contract address for the stream.
   * @param address - The Soroban token contract address.
   * @returns The builder instance for chaining.
   */
  token(address: string): this {
    this._token = StreamBuilder._validateAddress(address, 'token');
    return this;
  }

  /**
   * Sets the sender address for the stream.
   * @param address - The address that will send tokens.
   * @returns The builder instance for chaining.
   */
  sender(address: string): this {
    this._sender = StreamBuilder._validateAddress(address, 'sender');
    return this;
  }

  /**
   * Sets the recipient address for the stream.
   * @param address - The address that will receive tokens.
   * @returns The builder instance for chaining.
   */
  recipient(address: string): this {
    this._recipient = StreamBuilder._validateAddress(address, 'recipient');
    return this;
  }

  /**
   * Sets the amount of tokens to stream.
   * @param val - The amount in the token's smallest unit.
   * @returns The builder instance for chaining.
   */
  amount(val: number): this {
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error('Invalid StreamBuilder parameter: amount must be a positive finite number');
    }
    this._amount = val;
    return this;
  }

  /**
   * Sets the rate of tokens per second (in stroops).
   * Accepts a number or bigint; bigint values are serialised to
   * strings before network submission to avoid Safari/WebKit
   * JSON.stringify quirks.
   * @param val - The rate per second in stroops.
   * @returns The builder instance for chaining.
   */
  ratePerSecond(val: number | bigint): this {
    if (typeof val === 'bigint') {
      if (val <= 0n) {
        throw new Error('Invalid StreamBuilder parameter: ratePerSecond must be a positive value');
      }
    } else {
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error('Invalid StreamBuilder parameter: ratePerSecond must be a positive finite number');
      }
    }
    this._ratePerSecond = val;
    return this;
  }

  /**
   * Validates and produces the final stream configuration.
   * Any bigint fields are converted to strings to guarantee safe
   * serialisation across all browsers (Safari/WebKit included).
   * @returns An object containing `token`, `sender`, `recipient`, `amount`, and optionally `ratePerSecond`.
   * @throws {Error} If any required field (`token`, `sender`, `recipient`, `amount`) is missing or malformed.
   */
  build() {
    if (this.isDestroyed) {
      throw new Error('StreamBuilder has been destroyed');
    }
    if (this._token === undefined || this._token === null ||
        this._sender === undefined || this._sender === null ||
        this._recipient === undefined || this._recipient === null ||
        this._amount === undefined || this._amount === null) {
      throw new Error('Missing required parameters for StreamBuilder');
    }

    const config: Record<string, unknown> = {
      token: this._token,
      sender: this._sender,
      recipient: this._recipient,
      amount: this._amount,
    };
    if (this._ratePerSecond !== undefined && this._ratePerSecond !== null) {
      // build()'s return type promises `ratePerSecond?: string`, but
      // bigintSafeStringify() only stringifies `bigint` values — a `number`
      // input would otherwise pass through unchanged and lie about its type
      // at runtime. Coerce numeric inputs here so the declared type is
      // honest (see #459).
      config.ratePerSecond = typeof this._ratePerSecond === 'number'
        ? String(this._ratePerSecond)
        : this._ratePerSecond;
    }

    return bigintSafeStringify(config) as {
      token: string;
      sender: string;
      recipient: string;
      amount: number;
      ratePerSecond?: string;
    };
  }

  /**
   * Submit built payload over network with automatic retries, payload queueing,
   * and concurrency control to prevent degradation under high load.
   */
  async submit(
    submitFn: (payload: Record<string, unknown>) => Promise<unknown>,
    options: SubmitOptions = {}
  ): Promise<unknown> {
    if (this.isDestroyed) {
      throw new Error('StreamBuilder has been destroyed');
    }
    if (typeof submitFn !== 'function') {
      throw new Error('submitFn must be a valid function');
    }

    const { signal } = options;
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Backpressure: reject if queue is full
    if (this.pendingQueue.length >= this._maxQueueSize) {
      throw new Error(
        `StreamBuilder queue is full (${this._maxQueueSize} pending). ` +
        'Retry later or increase maxQueueSize.'
      );
    }

    const payload = this.build();
    this.pendingQueue.push(payload as unknown as Record<string, unknown>);

    const maxRetries = options.maxRetries ?? 3;
    const baseRetryDelay = options.retryDelayMs ?? 100;

    await this._semaphore.acquire();
    try {
      let attempt = 0;
      let lastError: Error | unknown;

      while (attempt <= maxRetries) {
        if (this.isDestroyed) {
          throw new Error('StreamBuilder was destroyed during submission');
        }

        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        try {
          const result = await submitFn(payload as unknown as Record<string, unknown>);
          const index = this.pendingQueue.indexOf(payload as unknown as Record<string, unknown>);
          if (index !== -1) {
            this.pendingQueue.splice(index, 1);
          }
          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          lastError = err;
          attempt++;
          if (attempt <= maxRetries) {
            // Exponential backoff: delay doubles each retry
            const delay = baseRetryDelay * Math.pow(2, attempt - 1);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                this.activeTimers.delete(timer);
                resolve();
              }, delay);
              this.activeTimers.add(timer);

              if (signal) {
                const onAbort = () => {
                  clearTimeout(timer);
                  this.activeTimers.delete(timer);
                  signal.removeEventListener('abort', onAbort);
                  reject(new DOMException('Aborted', 'AbortError'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
              }
            });
          }
        }
      }

      throw new Error(
        `StreamBuilder network payload submission failed after ${maxRetries} retries: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`
      );
    } finally {
      // Remove payload from queue on both success and final failure
      const index = this.pendingQueue.indexOf(payload as unknown as Record<string, unknown>);
      if (index !== -1) {
        this.pendingQueue.splice(index, 1);
      }
      this._semaphore.release();
    }
  }

  getPendingQueue(): Array<Record<string, unknown>> {
    return [...this.pendingQueue];
  }

  cleanup(): void {
    this.isDestroyed = true;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.pendingQueue = [];
  }

  private static _validateAddress(address: string, field: string): string {
    if (typeof address !== 'string' || address.trim().length === 0) {
      throw new Error(`Invalid StreamBuilder parameter: ${field} must be a non-empty string`);
    }

    if (field === 'token') {
      if (!StrKey.isValidContract(address)) {
        throw new Error(
          `Invalid StreamBuilder parameter: ${field} must be a valid Soroban contract ID (C-address), got "${address}"`,
        );
      }
    } else {
      // sender / recipient — must be valid Ed25519 public keys (G-addresses)
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new Error(
          `Invalid StreamBuilder parameter: ${field} must be a valid Stellar public key (G-address), got "${address}"`,
        );
      }
    }

    return address;
  }
}

export interface BatchOperation {
  method: string;
  params: Record<string, unknown>;
  /**
   * Positional contract arguments. When present these are used verbatim,
   * giving exact control over the ABI. Otherwise `params` is passed as a
   * single map argument.
   */
  args?: unknown[];
}

export interface BatchExecuteOptions {
  maxBatchSize?: number;
  /**
   * Chain context used to build real transactions. Without it no XDR can be
   * produced and the call reports failure rather than returning a placeholder.
   */
  context?: BatchTransactionContext;
  /** Contract method invoked for each stream. Defaults to `create_stream`. */
  method?: string;
}

export interface BatchResult {
  success: boolean;
  operations: number;
  /**
   * First transaction's XDR, kept for backwards compatibility.
   *
   * A batch is several transactions (see `xdrs`), so prefer that field. Empty
   * string when nothing was built.
   */
  xdr: string;
  /**
   * One genuine, decodable transaction XDR per operation.
   *
   * Soroban allows a single `InvokeHostFunction` operation per transaction, so
   * N operations produce N transactions, to be submitted in this order.
   */
  xdrs?: string[];
  /** Per-transaction detail: source operation index, method, prepared flag. */
  transactions?: BuiltBatchTransaction[];
  /**
   * True when every transaction was simulated and assembled via RPC and is
   * ready to submit. False when built offline and still needing preparation.
   */
  prepared?: boolean;
  chunks?: number;
  errors?: string[];
}

const MISSING_CONTEXT_ERROR =
  'ConduitBatcher cannot build transaction XDR without a BatchTransactionContext ' +
  '(contractId, sourceAccount, network/networkPassphrase, and either sequence or rpcUrl). ' +
  'Pass one via options.context.';

/** Shape a successful build into a BatchResult. */
function toBatchResult(
  built: BuiltBatchTransaction[],
  chunks?: number,
): BatchResult {
  const xdrs = built.map(t => t.xdr);
  const result: BatchResult = {
    success: true,
    operations: built.length,
    xdr: xdrs[0] ?? '',
    xdrs,
    transactions: built,
    prepared: built.length > 0 && built.every(t => t.prepared),
  };
  if (chunks !== undefined) result.chunks = chunks;
  return result;
}

function toFailure(errors: string[], chunks?: number): BatchResult {
  const result: BatchResult = { success: false, operations: 0, xdr: '', xdrs: [], errors };
  if (chunks !== undefined) result.chunks = chunks;
  return result;
}

const DEFAULT_MAX_BATCH_SIZE = 50;

/**
 * Validate that the input is a non-null, non-empty array of objects.
 * Also validates individual fields (token, sender, recipient) for address format correctness.
 * Returns an array of error messages, or an empty array if valid.
 * Mandatory client-side validation prevents invalid payloads from reaching the smart contract.
 */
function validatePayload(streams: unknown): string[] {
  const errors: string[] = [];

  if (streams === null || streams === undefined) {
    errors.push('Batch payload cannot be null or undefined');
    return errors;
  }

  if (!Array.isArray(streams)) {
    errors.push('Batch payload must be an array');
    return errors;
  }

  for (let i = 0; i < streams.length; i++) {
    const item = streams[i];
    if (item === null || item === undefined) {
      errors.push(`Batch item at index ${i} cannot be null or undefined`);
    } else if (typeof item !== 'object') {
      errors.push(`Batch item at index ${i} must be an object, got ${typeof item}`);
    } else {
      // Field-level validation for known address-type fields
      const obj = item as Record<string, unknown>;

      // Validate token field — must be a valid Soroban contract ID (C-address)
      if (obj.token !== undefined && obj.token !== null) {
        const token = String(obj.token);
        if (!StrKey.isValidContract(token)) {
          errors.push(`Batch item at index ${i}: token must be a valid Soroban contract ID (C-address), got "${token}"`);
        }
      }

      // Validate sender field — must be a valid Ed25519 public key (G-address)
      if (obj.sender !== undefined && obj.sender !== null) {
        const sender = String(obj.sender);
        if (!StrKey.isValidEd25519PublicKey(sender)) {
          errors.push(`Batch item at index ${i}: sender must be a valid Stellar public key (G-address), got "${sender}"`);
        }
      }

      // Validate recipient field — must be a valid Ed25519 public key (G-address)
      if (obj.recipient !== undefined && obj.recipient !== null) {
        const recipient = String(obj.recipient);
        if (!StrKey.isValidEd25519PublicKey(recipient)) {
          errors.push(`Batch item at index ${i}: recipient must be a valid Stellar public key (G-address), got "${recipient}"`);
        }
      }

      // Validate amount field — must be a positive finite number (where present)
      if (obj.amount !== undefined && obj.amount !== null) {
        const amount = Number(obj.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          errors.push(`Batch item at index ${i}: amount must be a positive finite number, got "${obj.amount}"`);
        }
      }
    }
  }

  return errors;
}

interface PendingBatch {
  operations: BatchOperation[];
  signal?: AbortSignal | undefined;
  context?: BatchTransactionContext | undefined;
  resolve: (result: BatchResult) => void;
}

export interface BatchExecuteAsyncOptions {
  signal?: AbortSignal;
  /** Chain context used to build real transactions. Required to produce XDR. */
  context?: BatchTransactionContext;
}

/**
 * Batches multiple stream operations into a single transaction.
 * Maintains independent state per instance (not a global singleton).
 * Each instance has its own queue, destroy flag, and processing state,
 * allowing multiple independent batchers to run side-by-side without interference.
 */
export class ConduitBatcher {
  private activeCallbacks: Set<() => void> = new Set();
  private isDestroyed = false;
  private batchQueue: PendingBatch[] = [];
  private processingBatch = false;

  /**
   * Bundle multiple stream operations into a single transaction (synchronous).
   *
   * Any `bigint` fields inside the stream objects are converted to
   * strings before further processing so that downstream
   * `JSON.stringify` calls produce valid payloads on Safari / WebKit
   * browsers (which serialise bigint as `{}` instead of throwing).
   *
   * Invalid payloads return `{ success: false, errors: [...] }` rather
   * than throwing. Only a destroyed batcher causes a throw.
   */
  execute(
    streams: Record<string, unknown>[],
    options?: BatchExecuteOptions,
  ): BatchResult {
    if (this.isDestroyed) {
      throw new Error('ConduitBatcher has been destroyed');
    }

    const validationErrors = validatePayload(streams);
    if (validationErrors.length > 0) {
      return toFailure(validationErrors);
    }

    const sanitized = streams.map(bigintSafeStringify) as Record<string, unknown>[];
    const resolvedMaxBatchSize = options?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    const chunks = sanitized.length === 0 ? 0 : Math.ceil(sanitized.length / resolvedMaxBatchSize);

    // Nothing to build is a legitimate no-op, not a failure.
    if (sanitized.length === 0) {
      return { success: true, operations: 0, xdr: '', xdrs: [], transactions: [], prepared: true, chunks };
    }

    if (!options?.context) {
      return toFailure([MISSING_CONTEXT_ERROR], chunks);
    }

    const contextErrors = validateContext(options.context);
    if (contextErrors.length > 0) {
      return toFailure(contextErrors, chunks);
    }
    if (options.context.sequence === undefined) {
      // execute() is synchronous, so it cannot fetch a sequence number over
      // RPC. Callers who only have an rpcUrl must use executeAsync().
      return toFailure(
        ['execute() is synchronous and cannot fetch a sequence number; ' +
         'supply context.sequence, or use executeAsync() to fetch it via rpcUrl'],
        chunks,
      );
    }

    const method = options.method ?? 'create_stream';
    const operations = sanitized.map(params => ({ method, params }));

    try {
      return toBatchResult(buildBatchTransactionsSync(operations, options.context), chunks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toFailure([message], chunks);
    }
  }

  /**
   * Asynchronously execute a batch with lifecycle tracking.
   * Ensures pending callbacks are tracked and can be cleaned up on teardown.
   */
  async executeAsync(
    operations: BatchOperation[],
    signalOrOptions?: AbortSignal | BatchExecuteAsyncOptions,
  ): Promise<BatchResult> {
    if (this.isDestroyed) {
      throw new Error('ConduitBatcher has been destroyed');
    }

    // Accept the original `(operations, signal)` shape alongside the options
    // object, so existing callers keep working.
    const isSignal =
      typeof signalOrOptions === 'object' &&
      signalOrOptions !== null &&
      'aborted' in signalOrOptions;
    const signal = isSignal
      ? (signalOrOptions as AbortSignal)
      : (signalOrOptions as BatchExecuteAsyncOptions | undefined)?.signal;
    const context = isSignal
      ? undefined
      : (signalOrOptions as BatchExecuteAsyncOptions | undefined)?.context;

    return new Promise<BatchResult>((resolve) => {
      const entry: PendingBatch = { operations, signal, context, resolve };
      this.batchQueue.push(entry);

      const cleanup = () => {
        this.activeCallbacks.delete(cleanup);
      };
      this.activeCallbacks.add(cleanup);

      if (!this.processingBatch) {
        this.processQueue();
      }

      cleanup();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processingBatch || this.isDestroyed) return;
    this.processingBatch = true;

    while (this.batchQueue.length > 0 && !this.isDestroyed) {
      const entry = this.batchQueue.shift();
      if (!entry) continue;

      const { operations: ops, signal, context, resolve } = entry;

      let cancelled = false;
      const onAbort = () => { cancelled = true; };
      if (signal) {
        if (signal.aborted) {
          cancelled = true;
        } else {
          signal.addEventListener('abort', onAbort);
        }
      }

      try {
        if (cancelled) {
          resolve(toFailure(['Operation aborted']));
          continue;
        }

        const validationErrors = validatePayload(ops);
        if (validationErrors.length > 0) {
          resolve(toFailure(validationErrors));
          continue;
        }

        const sanitized = ops.map(op => ({
          ...op,
          params: bigintSafeStringify(op.params) as Record<string, unknown>,
        }));

        if (sanitized.length === 0) {
          resolve({ success: true, operations: 0, xdr: '', xdrs: [], transactions: [], prepared: true });
          continue;
        }

        if (!context) {
          resolve(toFailure([MISSING_CONTEXT_ERROR]));
          continue;
        }

        const contextErrors = validateContext(context);
        if (contextErrors.length > 0) {
          resolve(toFailure(contextErrors));
          continue;
        }

        try {
          const built = await buildBatchTransactions(sanitized, context);
          if (cancelled) {
            resolve(toFailure(['Operation aborted']));
            continue;
          }
          resolve(toBatchResult(built));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resolve(toFailure([message]));
        }
      } finally {
        if (signal && !cancelled) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }

    this.processingBatch = false;
  }

  /**
   * Clean up all pending callbacks and reset state.
   * Does NOT reset the destroyed flag — use destroy() for permanent teardown.
   */
  cleanup(): void {
    this.processingBatch = false;

    const oldQueue = this.batchQueue;
    this.batchQueue = [];

    oldQueue.forEach((entry) => {
      entry.resolve(toFailure(['ConduitBatcher cleaned up']));
    });

    for (const cb of this.activeCallbacks) {
      cb();
    }
    this.activeCallbacks.clear();
  }

  /**
   * Permanently destroy the batcher. All pending operations are rejected
   * and subsequent calls to execute/executeAsync will throw.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.cleanup();
  }

  /**
   * Full reset: clears destroyed flag and cleans up pending operations.
   * Allows the batcher to be reused after destroy.
   */
  reset(): void {
    this.isDestroyed = false;
    this.cleanup();
  }
}
