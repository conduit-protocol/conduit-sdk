import type { StreamInfo } from './types/index.js';
import { StrKey } from '@stellar/stellar-sdk';

const _powCache: Record<number, bigint> = {};

function _pow10(decimals: number): bigint {
  let p = _powCache[decimals];
  if (!p) {
    p = BigInt(10) ** BigInt(decimals);
    _powCache[decimals] = p;
  }
  return p;
}

/** Convert a display amount string to stroops (bigint).
 *
 *  Cache-friendly — `10 ** decimals` is computed once per unique `decimals`
 *  value and reused across calls, avoiding repeated BigInt exponentiation.
 */
export function toStroops(amount: string, decimals = 7): bigint {
  const dot = amount.indexOf('.');
  if (dot === -1) {
    return BigInt(amount) * _pow10(decimals);
  }
  const whole = amount.slice(0, dot) || '0';
  const frac  = amount.slice(dot + 1, dot + 1 + decimals);
  const rest  = amount.slice(dot + 1 + decimals);

  let base = BigInt(whole) * _pow10(decimals) + BigInt(frac.padEnd(decimals, '0'));
  if (rest) {
    const roundingDigit = rest.charCodeAt(0) /* '0' … '9' */;
    if (roundingDigit >= 53 /* charCode of '5' */) {
      base += 1n;
    }
  }
  return base;
}

/** Convert stroops (bigint) to a display amount string */
export function fromStroops(stroops: bigint, decimals = 7): string {
  const factor = _pow10(decimals);
  const whole  = stroops / factor;
  const frac   = (stroops % factor).toString().padStart(decimals, '0');
  let end = frac.length;
  while (end > 0 && frac.charCodeAt(end - 1) === 48 /* '0' */) end--;
  const trimmed = end === 0 ? '0' : frac.slice(0, end);
  return `${whole}.${trimmed}`;
}

/**
 * Calculate the rate per second (in stroops) from a total deposit and duration.
 *
 * @param depositAmount  Display amount string, e.g. '1000'
 * @param durationSecs   Duration in seconds
 * @param decimals       Token decimal places (default 7 for Stellar assets)
 */
export function calculateRate(depositAmount: string, durationSecs: number, decimals = 7): bigint {
  const stroops = toStroops(depositAmount, decimals);
  const divisor = BigInt(durationSecs);
  if (divisor === 0n) return 0n;
  const quotient = stroops / divisor;
  const remainder = stroops % divisor;
  // Round to nearest: if remainder >= half the divisor, round up
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/**
 * Current progress fraction (0-1) of a stream.
 * Returns 0 if not started, 1 if ended, and NaN for open-ended streams
 * that have started but do not have a finite completion percentage.
 */
export function streamProgress(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): number {
  const { startTime, endTime } = stream;
  if (nowSec < startTime) return 0;
  if (endTime === 0)       return Number.NaN;  // open-ended
  if (nowSec >= endTime)   return 1;
  return (nowSec - startTime) / (endTime - startTime);
}

/**
 * Current withdrawable balance from a StreamInfo snapshot, without a contract call.
 * Accounts for pause state.
 */
export function withdrawableLocal(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (stream.cancelled) return 0n;

  const effectiveNow = stream.paused
    ? stream.pausedAt
    : stream.endTime > 0 && nowSec > stream.endTime
    ? stream.endTime
    : nowSec;

  if (effectiveNow < stream.startTime) return 0n;

  const elapsed = effectiveNow - stream.startTime;
  if (elapsed <= 0) return 0n;

  const streamed = stream.ratePerSecond * BigInt(elapsed);
  const available = streamed - stream.withdrawn;
  return available > 0n ? available : 0n;
}

/**
 * Recursively convert all bigint values in a value to their string
 * representation.  Safe for objects, arrays, and primitives.
 *
 * Safari / WebKit serialises `bigint` values as `{}` inside
 * `JSON.stringify`, which breaks payloads sent to the GraphQL
 * indexer.  Call this before network submission to guarantee
 * interoperability across all browsers.
 *
 * Uses a `WeakSet` to handle circular references without infinite
 * recursion, and iterates with indexed loops instead of `.map()` /
 * `.entries()` to minimise per-element allocations.
 */
export function bigintSafeStringify<T>(value: T): T {
  return _safeStringify(value, new WeakSet());
}

function _safeStringify<T>(value: T, visited: WeakSet<object>): T {
  if (typeof value === 'bigint') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return value.toString() as any;
  }
  if (value === null || typeof value !== 'object') return value;
  if (visited.has(value)) return value as T;
  visited.add(value);

  if (Array.isArray(value)) {
    const { length } = value;
    const out = new Array<unknown>(length);
    for (let i = 0; i < length; i++) {
      out[i] = _safeStringify(value[i], visited);
    }
    return out as unknown as T;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    out[k] = _safeStringify(obj[k], visited);
  }
  return out as T;
}

/**
 * Validates whether a string is a well-formed Stellar public key
 * (account address, e.g. 'GABC...XYZ').
 *
 * Performs static format validation only (StrKey encoding, version byte,
 * checksum) -- it does not check whether the account exists on-chain.
 * Use this to fail fast before submission, e.g. before passing a recipient
 * into client.streams.create().
 */
export function isValidAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) {
    return false;
  }
  return StrKey.isValidEd25519PublicKey(address);
}
