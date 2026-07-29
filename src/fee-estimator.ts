export interface FeeEstimatorOptions {
  /**
   * Minimum interval in milliseconds between network fetches.
   * Within this window, `estimateFee` serves the cached `baseFee`
   * instead of calling `networkFetcher` again. Default: no interval (every call fetches).
   */
  minRefetchIntervalMs?: number;
}

/**
 * Options for fee estimation with error handling callback.
 */

export interface FeeEstimateOptions {
  onError?: (error: Error) => void;
}

/**
 * Estimates Soroban fees with caching and fallback behavior.
 * Represents all fees as bigint stroops to maintain precision and avoid IEEE-754 rounding errors.
 * Consistent with the SDK's bigint-stroops convention used for all on-chain monetary amounts.
 */
export class FeeEstimator {
  private baseFee: bigint;
  private isEstimating: boolean = false;
  private currentPromise: Promise<bigint> | null = null;
  private readonly minRefetchIntervalMs: number;
  private lastSuccessfulFetchAtValue: number | null = null;
  private lastErrorValue: Error | null = null;

  /**
   * Creates a new FeeEstimator instance.
   *
   * @param initialFee - Starting fee in stroops (bigint). Defaults to 100n stroops.
   * @param options - Configuration options for caching behavior.
   */
  constructor(initialFee: bigint = 100n, options?: FeeEstimatorOptions) {
    this.baseFee = initialFee;
    this.minRefetchIntervalMs = options?.minRefetchIntervalMs ?? 0;
  }

  /**
   * Safely estimates the fee by fetching it asynchronously.
   * Utilizes an atomic state transition / locking mechanism to prevent race conditions
   * when multiple async hooks fire simultaneously.
   *
   * If `minRefetchIntervalMs` was configured, returns the cached `baseFee` when
   * called within that window after the last successful fetch.
   *
   * Returns fee as bigint stroops to avoid IEEE-754 floating-point precision loss.
   */
  async estimateFee(
    networkFetcher: () => Promise<bigint>,
    options: FeeEstimateOptions = {}
  ): Promise<bigint> {
    if (this.currentPromise) {
      return this.currentPromise;
    }

    // Return cached fee if within the minimum re-fetch interval
    if (this.minRefetchIntervalMs > 0) {
      const elapsed = Date.now() - (this.lastSuccessfulFetchAtValue ?? 0);
      if (elapsed < this.minRefetchIntervalMs) {
        return this.baseFee;
      }
    }

    this.currentPromise = (async () => {
      try {
        this.isEstimating = true;
        const rawFee = await networkFetcher();

        // Ensure bigint is valid and non-negative
        if (typeof rawFee !== 'bigint' || rawFee < 0n) {
            throw new Error("Invalid network fee response");
        }

        this.baseFee = rawFee;
        this.lastSuccessfulFetchAtValue = Date.now();
        this.lastErrorValue = null;
        return this.baseFee;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.lastErrorValue = normalizedError;
        options.onError?.(normalizedError);

        // Fallback sequence: return the last known base fee
        return this.baseFee;
      } finally {
        this.isEstimating = false;
        this.currentPromise = null;
      }
    })();

    return this.currentPromise;
  }

  get _isEstimating(): boolean {
    return this.isEstimating;
  }

  /**
   * Returns the current base fee in stroops (bigint).
   * This is either the last successfully fetched value or the initial/fallback fee.
   *
   * @returns The base fee as bigint stroops.
   */
  getBaseFee(): bigint {
    return this.baseFee;
  }

  get lastSuccessfulFetchAt(): number | null {
    return this.lastSuccessfulFetchAtValue;
  }

  get lastError(): Error | null {
    return this.lastErrorValue;
  }

  get isStale(): boolean {
    return this.lastErrorValue !== null;
  }
}
