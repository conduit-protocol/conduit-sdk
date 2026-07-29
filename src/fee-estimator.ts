export interface FeeEstimatorOptions {
  /**
   * Minimum interval in milliseconds between network fetches.
   * Within this window, `estimateFee` serves the cached `baseFee`
   * instead of calling `networkFetcher` again. Default: no interval (every call fetches).
   */
  minRefetchIntervalMs?: number;
}

export interface FeeEstimateOptions {
  onError?: (error: Error) => void;
}

export class FeeEstimator {
  private baseFee: number;
  private isEstimating: boolean = false;
  private currentPromise: Promise<number> | null = null;
  private readonly minRefetchIntervalMs: number;
  private lastSuccessfulFetchAtValue: number | null = null;
  private lastErrorValue: Error | null = null;

  constructor(initialFee: number = 100, options?: FeeEstimatorOptions) {
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
   */
  async estimateFee(
    networkFetcher: () => Promise<number>,
    options: FeeEstimateOptions = {}
  ): Promise<number> {
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
        
        // Ensure floating point math precision and error-boundary handler
        if (typeof rawFee !== 'number' || !Number.isFinite(rawFee) || rawFee < 0) {
            throw new Error("Invalid network fee response");
        }
        
        // Round to 7 decimal places for precision handling
        this.baseFee = Math.round(rawFee * 10000000) / 10000000;
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

  // Exposed for testing internal state
  get _isEstimating(): boolean {
    return this.isEstimating;
  }

  getBaseFee(): number {
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
