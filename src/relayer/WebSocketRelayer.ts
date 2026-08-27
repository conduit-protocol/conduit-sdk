export interface WebSocketMessage {
  type: string;
  payload: unknown;
  id?: string;
}

export type MessageHandler = (msg: WebSocketMessage) => Promise<void> | void;
export type StateChangeHandler = (transition: RelayerStateTransition, state: RelayerState) => void;

export interface RelayerState {
  connected: boolean;
  reconnecting: boolean;
  destroyed: boolean;
  pendingCount: number;
}

export type RelayerStateTransition = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'destroyed';

export interface WebSocketRelayerOptions {
  maxPendingMessages?: number;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  onStateChange?: StateChangeHandler;
}

export class WebSocketRelayer {
  private url: string;
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private isDestroyed = false;
  private isLocked = false;
  private lockQueue: Array<() => void> = [];
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectEnabled = true;
  private reconnectExhausted = false;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private pendingMessages: WebSocketMessage[] = [];
  private maxPendingMessages: number;
  private stateTransition: RelayerStateTransition = 'disconnected';

  constructor(url: string, options?: WebSocketRelayerOptions) {
    this.url = url;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 1000;
    this.maxPendingMessages = options?.maxPendingMessages ?? 1000;
    if (options?.onStateChange) {
      this.stateChangeHandlers.add(options.onStateChange);
    }
  }

  get state(): RelayerState {
    return {
      connected: this.ws !== null && this.ws.readyState === 1,
      reconnecting: this.reconnectAttempts > 0,
      destroyed: this.isDestroyed,
      pendingCount: this.pendingMessages.length,
    };
  }

  private async acquireLock(): Promise<void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return;
    }
    return new Promise((resolve) => {
      this.lockQueue.push(resolve);
    });
  }

  private releaseLock(): void {
    const next = this.lockQueue.shift();
    if (next) {
      next();
    } else {
      this.isLocked = false;
    }
  }

  private emitStateChange(transition: RelayerStateTransition): void {
    if (this.stateTransition === transition) return;

    this.stateTransition = transition;
    const state = this.state;
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(transition, state);
      } catch (err) {
        console.warn('[WebSocketRelayer] state change handler error:', err);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }
    this.reconnectEnabled = true;
    this.reconnectExhausted = false;
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Assign connectPromise synchronously — before the first `await` — so that
    // any connect() call arriving before this one settles sees it on the check
    // above and shares this promise instead of racing into a second
    // establishConnection() (see #492). Assigning it only after acquireLock()
    // resolves left a window where two near-simultaneous callers both passed
    // the check and both queued on the lock.
    const promise = this.doConnect();
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private async doConnect(): Promise<void> {
    await this.acquireLock();
    try {
      if (this.ws && this.ws.readyState === 1) {
        return;
      }

      this.emitStateChange('connecting');
      await this.establishConnection();
    } finally {
      this.releaseLock();
    }
  }

  private wsCtor(): typeof WebSocket | null {
    if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) {
      return (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    }
    if (typeof WebSocket !== 'undefined') {
      return WebSocket;
    }
    return null;
  }

  private async establishConnection(): Promise<void> {
    const WebSocketCtor = this.wsCtor();
    if (!WebSocketCtor) {
      this.emitStateChange('disconnected');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        let ws: WebSocket;
        try {
          ws = new WebSocketCtor(this.url);
        } catch {
          // Fallback for mocks that are plain functions.
          ws = (WebSocketCtor as unknown as (url: string) => WebSocket)(this.url);
        }
        if (!ws) {
          resolve();
          return;
        }
        let settled = false;

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          this.reconnectAttempts = 0;
          this.reconnectExhausted = false;
          this.flushPendingMessages();
          this.emitStateChange('connected');
          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessageSafe(event.data);
        };

        ws.onclose = () => {
          this.ws = null;
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection closed before opening: ${this.url}`));
          }
          this.emitStateChange('disconnected');
          if (!this.isDestroyed && this.reconnectEnabled) {
            this.attemptReconnect();
          }
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection failed: ${this.url}`));
          }
        };

        this.ws = ws;
      } catch (err) {
        reject(err);
      }
    });
  }

  private async safeInvokeHandler(handler: MessageHandler, msg: WebSocketMessage): Promise<void> {
    try {
      const result = handler(msg);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        await (result as Promise<void>).catch((err: Error) => {
          console.warn('[WebSocketRelayer] async handler error:', err);
        });
      }
    } catch (err) {
      console.warn('[WebSocketRelayer] handler error:', err);
    }
  }

  private handleMessageSafe(data: string): void {
    if (data === null || data === undefined) return;

    let parsed: WebSocketMessage;
    try {
      parsed = JSON.parse(data) as WebSocketMessage;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.type || typeof parsed.type !== 'string') return;

    const typeHandlers = this.handlers.get(parsed.type);
    if (!typeHandlers) return;

    for (const handler of typeHandlers) {
      this.safeInvokeHandler(handler, parsed);
    }
  }


  /** Idempotency guard: only reconnect if not already connected or reconnecting */
  private shouldAttemptReconnect(): boolean {
    return (
      !this.isDestroyed &&
      this.reconnectEnabled &&
      this.reconnectAttempts < this.maxReconnectAttempts &&
      (!this.ws || this.ws.readyState !== 1)
    );
  }

  private flushPendingMessages(): void {
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (const msg of pending) {
      this.send(msg).catch(() => {});
    }
  }

  /**
   * True once reconnection has been given up on — attempts exhausted, socket
   * still not open, but the relayer wasn't explicitly disconnected/destroyed.
   * `send()` uses this to reject outright instead of queueing messages that
   * will never be flushed (see #491).
   */
  private isPermanentlyDown(): boolean {
    return (
      !this.isDestroyed &&
      this.reconnectEnabled &&
      this.reconnectAttempts >= this.maxReconnectAttempts &&
      (!this.ws || this.ws.readyState !== 1)
    );
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.shouldAttemptReconnect()) {
      if (this.isPermanentlyDown()) {
        this.reconnectExhausted = true;
      }
      return;
    }

    await this.acquireLock();
    try {
      if (!this.shouldAttemptReconnect()) return;

      this.reconnectAttempts++;
      this.emitStateChange('reconnecting');
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs * this.reconnectAttempts));
      if (this.isDestroyed) return;

      await this.establishConnection();
    } catch {
      // Reconnect attempt failed; the next scheduled attempt (if any) will retry.
    } finally {
      this.releaseLock();
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);

    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  off(type: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  /**
   * Push onto the bounded pending queue, dropping the oldest message once
   * `maxPendingMessages` is reached (see #491) — `send()` must route through
   * this rather than pushing to `pendingMessages` directly.
   */
  private _queueMessage(message: WebSocketMessage): void {
    if (this.pendingMessages.length >= this.maxPendingMessages) {
      this.pendingMessages.shift();
    }
    this.pendingMessages.push(message);
  }

  async send(message: WebSocketMessage): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }
    if (this.reconnectExhausted) {
      throw new Error(
        `WebSocketRelayer: connection to ${this.url} is down and reconnect attempts ` +
        `(${this.maxReconnectAttempts}) are exhausted; message was not queued`,
      );
    }

    if (!this.ws || this.ws.readyState !== 1) {
      this._queueMessage(message);
      return;
    }

    await this.acquireLock();
    try {
      if (this.isDestroyed) throw new Error('WebSocketRelayer has been destroyed');
      if (this.reconnectExhausted) {
        throw new Error(
          `WebSocketRelayer: connection to ${this.url} is down and reconnect attempts ` +
          `(${this.maxReconnectAttempts}) are exhausted; message was not queued`,
        );
      }
      if (!this.ws || this.ws.readyState !== 1) {
        this._queueMessage(message);
        return;
      }

      const payload = JSON.stringify(message);
      this.ws.send(payload);
    } finally {
      this.releaseLock();
    }
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.reconnectExhausted = false;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
      this.ws = null;
    }
    this.emitStateChange('disconnected');
  }

  destroy(): void {
    this.isDestroyed = true;
    this.reconnectEnabled = false;
    this.connectPromise = null;
    this.pendingMessages = [];
    this.reconnectAttempts = this.maxReconnectAttempts;

    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
      this.ws = null;
    }

    this.emitStateChange('destroyed');
    this.handlers.clear();
    this.stateChangeHandlers.clear();
    this.lockQueue = [];
    this.isLocked = false;
  }
}
