/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 *
 * Performance note: SorobanRpc.Server instances are cached per RPC URL
 * so that repeated calls (e.g. simulate → submit → poll) reuse the
 * same HTTP client, avoiding redundant TLS and connection-pool setup.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Contract,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { Network } from './types/index.js';
import type { Signer } from './signer.js';
import { RateLimitError } from './errors.js';

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: 'https://soroban-mainnet.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  local:   'http://localhost:8000/soroban/rpc',
};

export const NETWORK_PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  local:   Networks.STANDALONE,
};

/**
 * Cache SorobanRpc.Server instances per RPC URL so that callers
 * who invoke multiple RPC methods sequentially or in parallel do
 * not create a new HTTP client for every single call.
 * Keyed by rpcUrl so different network targets get independent caches.
 */
const _serverCache = new Map<string, SorobanRpc.Server>();

export function getServer(rpcUrl: string): SorobanRpc.Server {
  let srv = _serverCache.get(rpcUrl);
  if (!srv) {
    srv = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    _serverCache.set(rpcUrl, srv);
  }
  return srv;
}

/**
 * Clear the server cache. Intended for use in tests.
 */
export function clearServerCache(): void {
  _serverCache.clear();
}

export interface ConfirmationPollingOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 1000;
export const DEFAULT_CONFIRMATION_MAX_ATTEMPTS = 30;

function normalizePollingOptions(options: ConfirmationPollingOptions = {}): Required<ConfirmationPollingOptions> {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_CONFIRMATION_MAX_ATTEMPTS,
  };
}

/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
export async function buildContractCallTx(
  rpcUrl:      string,
  passphrase:  string,
  caller:      string,
  contractId:  string,
  method:      string,
  args:        xdr.ScVal[],
): Promise<ReturnType<TransactionBuilder['build']>> {
  const server  = getServer(rpcUrl);

  let account;
  try {
    account = await server.getAccount(caller);
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  const contract = new Contract(contractId);

  return new TransactionBuilder(account, {
    fee:            BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
export async function invokeContract(
  rpcUrl:     string,
  passphrase: string,
  signer:     Signer,
  tx:         ReturnType<TransactionBuilder['build']>,
  pollingOptions: ConfirmationPollingOptions = {},
): Promise<string> {
  const server = getServer(rpcUrl);
  const polling = normalizePollingOptions(pollingOptions);

  // Simulate
  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble (adds soroban auth + footprint)
  const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

  // Sign
  await signer.sign(assembled);

  // Submit
  let sent;
  try {
    sent = await server.sendTransaction(assembled);
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (sent.status === 'ERROR') {
    throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  // Poll for confirmation
  const hash = sent.hash;
  for (let i = 0; i < polling.maxAttempts; i++) {
    await sleep(polling.pollIntervalMs);
    let status;
    try {
      status = await server.getTransaction(hash);
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  throw new Error(`Transaction timed out: ${hash}`);
}

/**
 * Simulate a read-only call and return the result XDR.
 */
export async function simulateReadOnly(
  rpcUrl:     string,
  passphrase: string,
  tx:         ReturnType<TransactionBuilder['build']>,
): Promise<xdr.ScVal> {
  const server = getServer(rpcUrl);

  let result;
  try {
    result = await server.simulateTransaction(tx);
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }
  if (!result.result) {
    throw new Error('Simulation returned no result');
  }
  return xdr.ScVal.fromXDR(result.result.retval.toXDR());
}

/**
 * Query a token contract's `decimals()` — part of the standard Stellar
 * Asset / SEP-41 token interface every `CreateStreamParams.token` must
 * implement. Callers must not assume 7 decimals (the native XLM/Stellar
 * Asset Contract default) for arbitrary token addresses.
 */
export async function getTokenDecimals(
  rpcUrl:     string,
  passphrase: string,
  callerAddr: string,
  tokenId:    string,
): Promise<number> {
  const tx  = await buildContractCallTx(rpcUrl, passphrase, callerAddr, tokenId, 'decimals', []);
  const val = await simulateReadOnly(rpcUrl, passphrase, tx);
  return val.u32();
}

/** Convert an ScVal i128 to bigint */
export function scValToI128(val: xdr.ScVal): bigint {
  const i128 = val.i128();
  const hi   = BigInt(i128.hi().toString());
  const lo   = BigInt(i128.lo().toString());
  // hi is signed high 64 bits, lo is unsigned low 64 bits
  return (hi << 64n) | lo;
}

/** Convert an ScVal u64 to bigint */
export function scValToU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/** Encode a u64 value as ScVal */
export function u64ToScVal(val: bigint | number): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(val.toString()));
}

/** Encode a boolean as ScVal */
export function boolToScVal(val: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(val);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
