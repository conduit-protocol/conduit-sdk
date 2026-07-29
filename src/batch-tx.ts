/**
 * Real batch-transaction construction for {@link ConduitBatcher}.
 *
 * ## Why a batch is several transactions, not one
 *
 * Soroban permits exactly **one `InvokeHostFunction` operation per
 * transaction**. There is no way to pack N contract calls into a single
 * envelope, which is why the previous placeholder XDR was never replaced with
 * a real one — the shape it promised (`xdr: string` for N operations) is not
 * expressible on this network.
 *
 * So a batch builds **one genuine transaction per operation**. That matches how
 * the rest of the SDK already batches: `StreamsModule.batchWithdraw` issues one
 * transaction per withdrawal.
 *
 * ## What "submittable" means here
 *
 * A Soroban invocation is only submittable once it has been simulated, so the
 * network can attach its footprint and authorisation entries. Two levels:
 *
 * - **Offline** (`sequence` supplied, no `rpcUrl`): a well-formed, decodable
 *   transaction envelope. Not yet submittable — it still needs preparing.
 * - **Prepared** (`rpcUrl` supplied): simulated and assembled via RPC, so the
 *   footprint and auth are attached and the XDR can go straight to the network.
 *
 * `prepared` on the result says which one you got, so a caller is never left
 * guessing whether the XDR is ready.
 */

import {
  Account,
  Address,
  Contract,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from './soroban.js';
import { RateLimitError } from './errors.js';
import type { Network } from './types/index.js';

export const DEFAULT_BATCH_TIMEOUT_SECONDS = 30;

/**
 * Everything needed to turn a validated operation list into real transactions.
 *
 * Supply `sequence` to build offline, or `rpcUrl` to fetch the sequence and
 * produce prepared, submittable XDR. Supplying neither is an error — that is
 * exactly the gap the placeholder XDR used to paper over.
 */
export interface BatchTransactionContext {
  /** Soroban contract the batched operations are invoked against. */
  contractId: string;
  /** Source account (G-address) that will sign and pay for the transactions. */
  sourceAccount: string;
  /** Named network. Ignored when `networkPassphrase` is given. */
  network?: Network;
  /** Explicit passphrase, for networks not covered by {@link Network}. */
  networkPassphrase?: string;
  /**
   * Current sequence number of `sourceAccount`. Required for offline building.
   * Each operation in the batch consumes one sequence number, in order.
   */
  sequence?: string;
  /** Soroban RPC endpoint. When set, transactions are simulated and prepared. */
  rpcUrl?: string;
  /** Per-transaction fee in stroops. Defaults to `BASE_FEE`. */
  fee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeoutSeconds?: number;
}

/** One built transaction, with the operation it came from. */
export interface BuiltBatchTransaction {
  /** Index of the source operation in the input array. */
  index: number;
  method: string;
  xdr: string;
  /** True when simulated and assembled, so the XDR is ready to submit. */
  prepared: boolean;
}

export class BatchBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchBuildError';
  }
}

/** Resolve the passphrase from an explicit value or a named network. */
export function resolvePassphrase(context: BatchTransactionContext): string {
  if (context.networkPassphrase && context.networkPassphrase.trim().length > 0) {
    return context.networkPassphrase;
  }
  if (context.network) {
    const passphrase = NETWORK_PASSPHRASE[context.network];
    if (passphrase) return passphrase;
    throw new BatchBuildError(`Unknown network "${context.network}"`);
  }
  throw new BatchBuildError(
    'BatchTransactionContext requires either networkPassphrase or network',
  );
}

/**
 * Validate the context up front, so a caller gets a named problem instead of a
 * transaction that fails at submission.
 */
export function validateContext(context: BatchTransactionContext): string[] {
  const errors: string[] = [];

  if (!context || typeof context !== 'object') {
    return ['Batch transaction context is required to build XDR'];
  }
  if (!context.contractId || !StrKey.isValidContract(context.contractId)) {
    errors.push(
      `contractId must be a valid Soroban contract ID (C-address), got "${context.contractId}"`,
    );
  }
  if (!context.sourceAccount || !StrKey.isValidEd25519PublicKey(context.sourceAccount)) {
    errors.push(
      `sourceAccount must be a valid Stellar public key (G-address), got "${context.sourceAccount}"`,
    );
  }
  if (!context.network && !context.networkPassphrase) {
    errors.push('Either network or networkPassphrase must be provided');
  }
  if (context.network && !NETWORK_PASSPHRASE[context.network]) {
    errors.push(`Unknown network "${context.network}"`);
  }
  if (context.sequence === undefined && !context.rpcUrl) {
    errors.push(
      'Either sequence (to build offline) or rpcUrl (to fetch it and prepare) must be provided',
    );
  }
  if (context.sequence !== undefined && !/^\d+$/.test(String(context.sequence))) {
    errors.push(`sequence must be a non-negative integer string, got "${context.sequence}"`);
  }

  return errors;
}

/**
 * Convert a single parameter to an ScVal.
 *
 * Strings that are valid Stellar addresses become `Address` values rather than
 * string values — passing a G- or C-address as a plain string is a common way
 * to build a transaction the contract then rejects.
 */
export function paramToScVal(value: unknown): xdr.ScVal {
  // Values with no ScVal representation (symbols, functions, undefined) map to
  // void rather than throwing — validation has already accepted the payload, so
  // a stray non-serialisable field must not take the whole batch down.
  if (
    value === undefined ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return xdr.ScVal.scvVoid();
  }
  if (value === null) {
    return xdr.ScVal.scvVoid();
  }
  if (typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    return new Address(value).toScVal();
  }
  if (typeof value === 'bigint') {
    return nativeToScVal(value, { type: 'i128' });
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return nativeToScVal(value, { type: 'i64' });
  }
  return nativeToScVal(value);
}

/**
 * Build the argument list for one operation.
 *
 * `args` wins when present, so a caller who knows the contract ABI controls the
 * positional arguments exactly. Otherwise `params` is passed as a single map
 * argument, keyed by field name.
 */
export function operationToScVals(operation: {
  params?: Record<string, unknown> | undefined;
  args?: unknown[] | undefined;
}): xdr.ScVal[] {
  if (Array.isArray(operation.args)) {
    return operation.args.map(paramToScVal);
  }

  const params = operation.params ?? {};
  const entries = Object.entries(params);
  if (entries.length === 0) return [];

  return [
    xdr.ScVal.scvMap(
      entries
        // Soroban map keys must be sorted for the value to be canonical.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) =>
          new xdr.ScMapEntry({
            key: nativeToScVal(key, { type: 'symbol' }),
            val: paramToScVal(value),
          }),
        ),
    ),
  ];
}

interface BuildableOperation {
  method: string;
  params?: Record<string, unknown> | undefined;
  args?: unknown[] | undefined;
}

/**
 * Build one unsigned transaction per operation, offline.
 *
 * Requires `context.sequence`. Sequence numbers are consumed in order, so the
 * transactions are submitted in the same order they appear here.
 */
export function buildBatchTransactionsSync(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): BuiltBatchTransaction[] {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));
  if (context.sequence === undefined) {
    throw new BatchBuildError('sequence is required to build batch transactions offline');
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  return operations.map((operation, index) => {
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }

    // One sequence number per transaction, since each is submitted separately.
    const sequence = (BigInt(context.sequence as string) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, sequence);

    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();

    return { index, method: operation.method, xdr: tx.toXDR(), prepared: false };
  });
}

/**
 * Build one transaction per operation and prepare each via RPC simulation, so
 * the returned XDR carries its footprint and auth and is ready to submit.
 *
 * Falls back to offline building when no `rpcUrl` is configured.
 */
export async function buildBatchTransactions(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): Promise<BuiltBatchTransaction[]> {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));

  if (!context.rpcUrl) {
    return buildBatchTransactionsSync(operations, context);
  }

  const server = new SorobanRpc.Server(context.rpcUrl, {
    allowHttp: context.rpcUrl.startsWith('http://'),
  });

  let sequence = context.sequence;
  if (sequence === undefined) {
    try {
      const account = await server.getAccount(context.sourceAccount);
      sequence = account.sequenceNumber();
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  const built: BuiltBatchTransaction[] = [];

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }

    const txSequence = (BigInt(sequence) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, txSequence);

    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();

    let simulation;
    try {
      simulation = await server.simulateTransaction(tx);
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new BatchBuildError(
        `Simulation failed for operation ${index} (${operation.method}): ${simulation.error}`,
      );
    }

    const assembled = SorobanRpc.assembleTransaction(tx, simulation).build();
    built.push({ index, method: operation.method, xdr: assembled.toXDR(), prepared: true });
  }

  return built;
}
