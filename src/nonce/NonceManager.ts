export interface NonceLock {
  nonce: bigint;
  release: () => void;
}

export interface NonceManagerOptions {
  startNonce?: bigint | number | string;
  maxNonce?: bigint | number | string;
}

const MAX_SAFE_U64 = 18446744073709551615n;

interface QueueEntry {
  resolve: (value: NonceLock) => void;
  cancelled: boolean;
}

export class NonceManager {
  private currentNonce: bigint;
  private maxNonce: bigint;
  private isLocked = false;
  private lockQueue: QueueEntry[] = [];
  private acquiredNonces: Set<string> = new Set();
  private isDestroyed = false;

  constructor(options: NonceManagerOptions = {}) {
    const rawStart = options.startNonce ?? 0n;
    const rawMax = options.maxNonce ?? MAX_SAFE_U64;

    this.currentNonce = this.toSafeBigInt(rawStart);
    this.maxNonce = this.toSafeBigInt(rawMax);

    if (this.currentNonce < 0n) {
      throw new Error('NonceManager: startNonce cannot be negative');
    }
    if (this.maxNonce <= this.currentNonce) {
      throw new Error('NonceManager: maxNonce must be greater than startNonce');
    }
    if (this.maxNonce > MAX_SAFE_U64) {
      this.maxNonce = MAX_SAFE_U64;
    }
  }

  private toSafeBigInt(value: bigint | number | string): bigint {
    if (typeof value === 'string' && value.trim() === '') {
      // BigInt('') would coerce to 0n, silently masking a caller bug.
      throw new Error('NonceManager: nonce value cannot be an empty string');
    }
    try {
      return BigInt(value);
    } catch {
      throw new Error(
        `NonceManager: invalid nonce value "${String(value)}" — expected a non-negative integer (bigint, number, or numeric string)`,
      );
    }
  }

  private nonceKey(nonce: bigint): string {
    return nonce.toString();
  }

  async acquire(): Promise<NonceLock> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    if (!this.isLocked) {
      this.isLocked = true;
      return this.nextNonce();
    }

    return this.enqueue().promise;
  }

  /**
   * Queues a waiter for the lock and returns a handle that can cancel it.
   * A cancelled waiter is skipped (without consuming a nonce) once it
   * reaches the front of the queue, so an abandoned caller (e.g. a timed
   * out `acquireWithFallback`) never leaves the lock permanently held.
   */
  private enqueue(): { promise: Promise<NonceLock>; cancel: () => void } {
    const entry: QueueEntry = { resolve: () => undefined, cancelled: false };
    const promise = new Promise<NonceLock>((resolve) => {
      entry.resolve = resolve;
    });
    this.lockQueue.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  private nextNonce(): NonceLock {
    const nonce = this.currentNonce;
    if (nonce >= this.maxNonce) {
      this.releaseLock();
      throw new Error(`NonceManager: nonce ${nonce} exceeds maximum ${this.maxNonce}`);
    }

    this.currentNonce = nonce + 1n;
    const key = this.nonceKey(nonce);
    this.acquiredNonces.add(key);

    const release = () => {
      this.acquiredNonces.delete(key);
      this.releaseLock();
    };

    return { nonce, release };
  }

  private releaseLock(): void {
    let next = this.lockQueue.shift();
    while (next && next.cancelled) {
      next = this.lockQueue.shift();
    }
    if (next) {
      const lock = this.nextNonce();
      next.resolve(lock);
    } else {
      this.isLocked = false;
    }
  }

  get current(): bigint {
    return this.currentNonce;
  }

  get remaining(): bigint {
    return this.maxNonce - this.currentNonce;
  }

  get acquired(): number {
    return this.acquiredNonces.size;
  }

  async reset(nonce?: bigint | number): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    while (this.isLocked) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    this.currentNonce = nonce !== undefined ? this.toSafeBigInt(nonce) : 0n;
    this.acquiredNonces.clear();
    this.lockQueue = [];
    this.isLocked = false;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.lockQueue = [];
    this.isLocked = false;
    this.acquiredNonces.clear();
  }

  static isNonceValid(value: unknown): value is bigint {
    if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') {
      return false;
    }
    try {
      const n = typeof value === 'bigint' ? value : BigInt(value);
      return n >= 0n && n <= MAX_SAFE_U64;
    } catch {
      return false;
    }
  }

  async acquireWithFallback(timeoutMs = 5000): Promise<NonceLock> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    if (!this.isLocked) {
      this.isLocked = true;
      return this.nextNonce();
    }

    const { promise, cancel } = this.enqueue();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        cancel();
        reject(new Error(`NonceManager: acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (err) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(String(err));
    }
  }

  /** Safe acquisition with retry logic and exponential backoff. */
  async safeAcquire(
    retries = 3,
    delayMs = 100,
  ): Promise<NonceLock> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await this.acquireWithFallback();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error('NonceManager: safeAcquire failed');
  }
}