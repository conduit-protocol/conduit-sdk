/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Default page size for `FactoryModule` / `StreamsModule.list()` pagination. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Maximum page size the SDK will send to `DripFactory::streams_by_sender` /
 * `streams_by_recipient`. The contract itself does not clamp this — an
 * unbounded `limit` produces an oversized simulation response — so the SDK
 * enforces the README-documented max client-side (see #489).
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Clamp a caller-supplied list `limit` into the valid `[0, MAX_LIST_LIMIT]`
 * range expected by `streams_by_sender` / `streams_by_recipient`. Non-finite
 * input (NaN, ±Infinity) falls back to {@link DEFAULT_LIST_LIMIT} rather than
 * producing an invalid u32 conversion.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIST_LIMIT);
}
