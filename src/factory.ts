/**
 * FactoryModule — DripFactory read queries.
 */

import { nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';
import type { ConduitConfig } from './types/index.js';
import { ZERO_ADDR, DEFAULT_LIST_LIMIT, clampListLimit } from './constants.js';
import {
  buildContractCallTx,
  simulateReadOnly,
  scValToU64,
  scValToU32,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

export class FactoryModule {
  private readonly rpcUrl:      string;
  private readonly passphrase:  string;
  private readonly factoryId:   string;
  private readonly callerAddr:  string;

  // streamId -> contract address is set once at creation and never changes,
  // so a resolved (non-null) address can be cached for the lifetime of this
  // module instance. This avoids re-resolving the same address on every
  // stream operation (get/withdraw/cancel/pause/... all call streamAddress()
  // via StreamsModule._resolveAddr, and list() fans this out over a full page).
  private readonly addressCache = new Map<string, string>();

  constructor(private readonly config: ConduitConfig) {
    // Guard against direct construction with an unsupported network, which
    // would bypass the ConduitClient validation gate and produce a confusing
    // StrKey error deep inside stellar-sdk (fixes #157).
    if (!(SUPPORTED_NETWORKS as readonly string[]).includes(config.network)) {
      throw new UnsupportedChainError(config.network);
    }
    this.rpcUrl     = config.rpcUrl     ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    // There is no known default DripFactory deployment for any network —
    // shipping a placeholder string here means callers who forget to set
    // this fail deep inside @stellar/stellar-sdk with a confusing StrKey
    // error instead of a clear one at construction time.
    if (!config.factoryAddress) {
      throw new Error(
        `ConduitConfig.factoryAddress is required (no default DripFactory is known for network "${config.network}").`,
      );
    }
    this.factoryId  = config.factoryAddress;
    // For read-only calls we use the keypair's public key as the fee source;
    // if no keypair, we use the zero address (simulation only — no real account needed).
    this.callerAddr = config.keypair?.publicKey() ?? ZERO_ADDR;
  }

  /** Total number of streams ever created through this factory. */
  async streamCount(): Promise<bigint> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'stream_count', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToU64(val);
  }

  /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
  async streamAddress(streamId: bigint | string): Promise<string | null> {
    const id  = BigInt(streamId);
    const key = id.toString();

    const cached = this.addressCache.get(key);
    if (cached !== undefined) return cached;

    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'stream_address',
      [nativeToScVal(id, { type: 'u64' })],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);

    // Contract returns Option<Address> — void = None
    if (val.switch().name === 'scvVoid') return null;
    try {
      const addr = Address.fromScVal(val).toString();
      this.addressCache.set(key, addr);
      return addr;
    } catch {
      return null;
    }
  }

  /**
   * List stream IDs where `address` is the sender, paginated.
   * `limit` is clamped to `[0, 100]` (see README) — the contract does not
   * enforce this itself, so an out-of-range value is silently clamped rather
   * than sent through as-is (see #489).
   */
  async streamsBySender(address: string, offset = 0, limit = DEFAULT_LIST_LIMIT): Promise<bigint[]> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'streams_by_sender',
      [
        new Address(address).toScVal(),
        nativeToScVal(offset, { type: 'u32' }),
        nativeToScVal(clampListLimit(limit), { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /**
   * List stream IDs where `address` is the recipient, paginated.
   * `limit` is clamped to `[0, 100]` (see README) — the contract does not
   * enforce this itself, so an out-of-range value is silently clamped rather
   * than sent through as-is (see #489).
   */
  async streamsByRecipient(address: string, offset = 0, limit = DEFAULT_LIST_LIMIT): Promise<bigint[]> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'streams_by_recipient',
      [
        new Address(address).toScVal(),
        nativeToScVal(offset, { type: 'u32' }),
        nativeToScVal(clampListLimit(limit), { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
  async protocolFeeBps(): Promise<number> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'protocol_fee_bps', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToU32(val);
  }

  private parseU64Vec(val: xdr.ScVal): bigint[] {
    const items = val.vec();
    if (!items) return [];
    return items.map(v => scValToU64(v));
  }
}
