import type { WebSocketRelayer, WebSocketMessage, MessageHandler } from './WebSocketRelayer.js';
import { ConduitError, type ConduitContract } from '../errors.js';

export type MappedErrorHandler = (error: Error) => void;

/** WebSocket message types that carry a raw on-chain error payload, and which contract each belongs to. */
const ERROR_MESSAGE_TYPES: Record<string, ConduitContract> = {
  stream_error: 'stream',
  factory_error: 'factory',
  governor_error: 'governor',
};

/**
 * Subscribes to error-shaped messages on a `WebSocketRelayer` and forwards
 * them to `onError` as typed `ConduitError` instances instead of raw payloads.
 *
 * Must be paired with `dispose()` — see #81. Without it, each `attach()`
 * leaves its listeners registered on the relayer forever, and any handler
 * call still in flight when the caller stops caring can fire late.
 */
export class ErrorMapper {
  private readonly relayer: WebSocketRelayer;
  private readonly onError: MappedErrorHandler;
  private unsubscribers: Array<() => void> = [];
  private isDisposed = false;

  constructor(relayer: WebSocketRelayer, onError: MappedErrorHandler) {
    this.relayer = relayer;
    this.onError = onError;
  }

  /** Registers one relayer listener per error message type. Safe to call more than once on active instances. Throws if disposed. */
  attach(): void {
    if (this.isDisposed) {
      throw new Error('Cannot attach a disposed ErrorMapper');
    }

    // Re-attaching without detaching first would register a second set of
    // listeners on top of the first, leaking the originals. Guard against it.
    this.detach();

    for (const type of Object.keys(ERROR_MESSAGE_TYPES)) {
      const handler: MessageHandler = (msg) => this.handleMessage(type, msg);
      this.unsubscribers.push(this.relayer.on(type, handler));
    }
  }


  private handleMessage(type: string, msg: WebSocketMessage): void {
    // Boundary check: bail before touching a disposed mapper or a
    // null/malformed payload, rather than passing it downstream.
    if (this.isDisposed || !msg || typeof msg !== 'object' || msg.payload == null) {
      return;
    }

    const contract = ERROR_MESSAGE_TYPES[type];
    if (!contract) return;

    const mapped = ConduitError.fromContractError(contract, msg.payload);

    // Re-check disposal after mapping: dispose() may have run while this
    // callback was pending, and state shouldn't mutate after teardown.
    if (this.isDisposed) return;

    this.onError(mapped);
  }

  /** Unsubscribes every listener this mapper registered on the relayer. */
  detach(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  /** Detaches all listeners and permanently blocks any in-flight callback from firing. */
  dispose(): void {
    this.isDisposed = true;
    this.detach();
  }
}
