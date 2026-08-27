import { StrKey } from '@stellar/stellar-sdk';

/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Circle's USDC issuer accounts, keyed by network. Used to resolve the
 * `'USDC'` shorthand in `StreamsModule.create` to a real Stellar asset (see
 * #508 — the previous mainnet constant was a placeholder strkey that failed
 * checksum validation and threw on every mainnet `create({ token: 'USDC' })`
 * call).
 */
export const USDC_ISSUER = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const;

for (const [network, issuer] of Object.entries(USDC_ISSUER)) {
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(`Invalid USDC issuer strkey configured for ${network}: "${issuer}"`);
  }
}

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
