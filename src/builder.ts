import { bigintSafeStringify } from './utils.js';

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
      config.ratePerSecond = this._ratePerSecond;
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
        `StreamBuilder network payload submission failed after ${maxRetries} retries without payload drop: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`
      );
    } finally {
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
    return address;
  }
}

export interface BatchOperation {
  method: string;
  params: Record<string, unknown>;
}

export interface BatchExecuteOptions {
  maxBatchSize?: number;
}

export interface BatchResult {
  success: boolean;
  operations: number;
  xdr: string;
  chunks?: number;
  errors?: string[];
}

const DEFAULT_MAX_BATCH_SIZE = 50;

/**
 * Validate that the input is a non-null, non-empty array of objects.
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
    }
  }

  return errors;
}

interface PendingBatch {
  operations: BatchOperation[];
  signal?: AbortSignal | undefined;
  resolve: (result: BatchResult) => void;
}

export class ConduitBatcher {
  private static activeCallbacks: Set<() => void> = new Set();
  private static isDestroyed = false;
  private static batchQueue: PendingBatch[] = [];
  private static processingBatch = false;

  /**
   * Bundle multiple stream operations into a single transaction.
   *
   * Any `bigint` fields inside the stream objects are converted to
   * strings before further processing so that downstream
   * `JSON.stringify` calls produce valid payloads on Safari / WebKit
   * browsers (which serialise bigint as `{}` instead of throwing).
   *
   * Invalid payloads return `{ success: false, errors: [...] }` rather
   * than throwing. Only a destroyed batcher causes a throw.
   */
  static execute(
    streams: Record<string, unknown>[],
    options?: BatchExecuteOptions,
  ): BatchResult {
    if (ConduitBatcher.isDestroyed) {
      throw new Error('ConduitBatcher has been destroyed');
    }

    const validationErrors = validatePayload(streams);
    if (validationErrors.length > 0) {
      return {
        success: false,
        operations: 0,
        xdr: '',
        errors: validationErrors,
      };
    }

    const sanitized = streams.map(bigintSafeStringify);
    const resolvedMaxBatchSize = options?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    const chunks = sanitized.length === 0 ? 0 : Math.ceil(sanitized.length / resolvedMaxBatchSize);

    return {
      success: true,
      operations: sanitized.length,
      xdr: 'AAAA...mock...batch...XDR',
      chunks,
    };
  }

  /**
   * Asynchronously execute a batch with lifecycle tracking.
   * Ensures pending callbacks are tracked and can be cleaned up on teardown.
   */
  static async executeAsync(
    operations: BatchOperation[],
    signal?: AbortSignal,
  ): Promise<BatchResult> {
    if (ConduitBatcher.isDestroyed) {
      throw new Error('ConduitBatcher has been destroyed');
    }

    return new Promise<BatchResult>((resolve) => {
      const entry: PendingBatch = { operations, signal, resolve };
      ConduitBatcher.batchQueue.push(entry);

      const cleanup = () => {
        ConduitBatcher.activeCallbacks.delete(cleanup);
      };
      ConduitBatcher.activeCallbacks.add(cleanup);

      if (!ConduitBatcher.processingBatch) {
        ConduitBatcher.processQueue();
      }

      cleanup();
    });
  }

  private static async processQueue(): Promise<void> {
    if (ConduitBatcher.processingBatch || ConduitBatcher.isDestroyed) return;
    ConduitBatcher.processingBatch = true;

    while (ConduitBatcher.batchQueue.length > 0 && !ConduitBatcher.isDestroyed) {
      const entry = ConduitBatcher.batchQueue.shift();
      if (!entry) continue;

      const { operations: ops, signal, resolve } = entry;

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
          resolve({ success: false, operations: 0, xdr: '', errors: ['Operation aborted'] });
          continue;
        }

        const validationErrors = validatePayload(ops);
        if (validationErrors.length > 0) {
          resolve({
            success: false,
            operations: 0,
            xdr: '',
            errors: validationErrors,
          });
          continue;
        }

        const sanitized = ops.map(op => ({
          ...op,
          params: bigintSafeStringify(op.params),
        }));

        resolve({
          success: true,
          operations: sanitized.length,
          xdr: "AAAA...mock...batch...XDR",
        });
      } finally {
        if (signal && !cancelled) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }

    ConduitBatcher.processingBatch = false;
  }

  /**
   * Clean up all pending callbacks and reset state.
   * Does NOT reset the destroyed flag — use destroy() for permanent teardown.
   */
  static cleanup(): void {
    ConduitBatcher.processingBatch = false;

    const oldQueue = ConduitBatcher.batchQueue;
    ConduitBatcher.batchQueue = [];

    oldQueue.forEach((entry) => {
      entry.resolve({ success: false, operations: 0, xdr: '', errors: ['ConduitBatcher cleaned up'] });
    });

    for (const cb of ConduitBatcher.activeCallbacks) {
      cb();
    }
    ConduitBatcher.activeCallbacks.clear();
  }

  /**
   * Permanently destroy the batcher. All pending operations are rejected
   * and subsequent calls to execute/executeAsync will throw.
   */
  static destroy(): void {
    ConduitBatcher.isDestroyed = true;
    ConduitBatcher.cleanup();
  }

  /**
   * Full reset: clears destroyed flag and cleans up pending operations.
   * Allows the batcher to be reused after destroy.
   */
  static reset(): void {
    ConduitBatcher.isDestroyed = false;
    ConduitBatcher.cleanup();
  }
}
