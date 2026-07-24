export class NonceManager {
  private currentNonce: number;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(initialNonce: number = 0) {
    this.currentNonce = initialNonce;
  }

  /**
   * Safely fetches and manages the next nonce asynchronously.
   * Uses a serialized update queue so concurrent callers cannot race.
   */
  async getNextNonce(networkFetcher: () => Promise<number>): Promise<number> {
    const previousUpdate = this.updateQueue;
    let release: (() => void) | undefined;

    this.updateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousUpdate;

    try {
      const rawResponse = await networkFetcher();
      const networkNonce = Number.isFinite(rawResponse) ? Math.floor(rawResponse) : NaN;

      if (Number.isNaN(networkNonce)) {
        this.currentNonce += 1;
        return this.currentNonce;
      }

      this.currentNonce = Math.max(this.currentNonce + 1, networkNonce);
      return this.currentNonce;
    } catch {
      this.currentNonce += 1;
      return this.currentNonce;
    } finally {
      release?.();
    }
  }

  getCurrentNonce(): number {
    return this.currentNonce;
  }
}
