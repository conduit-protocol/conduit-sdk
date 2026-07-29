export interface WebSocketMessage {
  type: string;
  payload: unknown;
  id?: string;
}

export type MessageHandler = (msg: WebSocketMessage) => Promise<void> | void;

export interface RelayerState {
  connected: boolean;
  reconnecting: boolean;
  destroyed: boolean;
  pendingCount: number;
}

export type RelayerStateTransition = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'destroyed';

export class WebSocketRelayer {
  private url: string;
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private isDestroyed = false;
  private isLocked = false;
  private lockQueue: Array<() => void> = [];
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private pendingMessages: WebSocketMessage[] = [];

  constructor(url: string, options?: { maxReconnectAttempts?: number; reconnectDelayMs?: number }) {
    this.url = url;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 1000;
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

  async connect(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }
    return this.connectPromise ?? (this.connectPromise = (async () => {
      try {
        await this.acquireLock();
        if (this.ws && this.ws.readyState === 1) return;
        await this.establishConnection();
      } finally {
        this.connectPromise = null;
        this.releaseLock();
      }
    })());
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
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        let wsInstance: any;
        try {
          wsInstance = new (WebSocketCtor as any)(this.url);
        } catch {
          // Fallback for mocks that are plain functions.
          wsInstance = (WebSocketCtor as any)(this.url);
        }
        const ws = wsInstance;
        if (!ws) {
          resolve();
          return;
        }
        let settled = false;

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          this.reconnectAttempts = 0;
          this.flushPendingMessages();
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
          if (!settled && !this.isDestroyed) {
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

  private async attemptReconnect(): Promise<void> {
    if (!this.shouldAttemptReconnect()) return;

    await this.acquireLock();
    try {
      if (!this.shouldAttemptReconnect()) return;

      this.reconnectAttempts++;
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

  off(type: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  async send(message: WebSocketMessage): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }

    if (!this.ws || this.ws.readyState !== 1) {
      this.pendingMessages.push(message);
      return;
    }

    await this.acquireLock();
    try {
      if (this.isDestroyed) throw new Error('WebSocketRelayer has been destroyed');
      if (!this.ws || this.ws.readyState !== 1) {
        this.pendingMessages.push(message);
        return;
      }

      const payload = JSON.stringify(message);
      this.ws.send(payload);
    } finally {
      this.releaseLock();
    }
  }

  disconnect(): void {
    this.connectPromise = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
      this.ws = null;
    }
  }

  destroy(): void {
    this.isDestroyed = true;
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

    this.handlers.clear();
    this.lockQueue = [];
    this.isLocked = false;
  }
}
