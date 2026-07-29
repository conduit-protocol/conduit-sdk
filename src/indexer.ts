export interface GraphQLQueryOptions {
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface GraphQLSubscriptionOptions {
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  onData: (data: unknown) => void;
  onError?: (error: Error) => void;
}

export interface IndexerSubscription {
  unsubscribe: () => void;
}

export class GraphQLIndexer {
  private endpoint: string;
  private activeSubscriptions: Set<IndexerSubscription> = new Set();
  private isDestroyed = false;
  private subCounter = 0;

  constructor(endpoint: string) {
    if (!endpoint || typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('GraphQLIndexer endpoint must be a non-empty string');
    }
    this.endpoint = endpoint;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLQueryOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL query string cannot be null or empty');
    }

    const variables = options.variables ?? {};
    if (typeof variables !== 'object' || variables === null) {
      throw new Error('GraphQL query variables must be an object');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    const fetchFn = typeof fetch !== 'undefined' ? fetch : (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== 'function') {
      throw new Error('Fetch API is not available in the current environment');
    }

    const response = await fetchFn(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: options.query,
        variables,
      }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL query failed with status ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLSubscriptionOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL subscription query string cannot be null or empty');
    }
    if (typeof options.onData !== 'function') {
      throw new Error('GraphQL subscription onData callback must be a function');
    }

    const variables = options.variables ?? {};
    if (typeof variables !== 'object' || variables === null) {
      throw new Error('GraphQL query variables must be an object');
    }

    let unsubscribed = false;
    const subId = `sub_${++this.subCounter}_${Date.now()}`;

    let ws: WebSocket | null = null;
    let abortController: AbortController | null = null;

    const subscription: IndexerSubscription = {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;

        if (ws) {
          try {
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify({ id: subId, type: 'complete' }));
            }
            ws.close();
          } catch {
            // Ignore socket closure errors
          }
          ws = null;
        }

        if (abortController) {
          try {
            abortController.abort();
          } catch {
            // Ignore abort error
          }
          abortController = null;
        }

        this.activeSubscriptions.delete(subscription);
      },
    };

    this.activeSubscriptions.add(subscription);

    const WebSocketCtor = this.getWebSocketCtor();
    if (WebSocketCtor) {
      try {
        const wsUrl = this.getWsUrl(this.endpoint);
        let socket: WebSocket;
        try {
          socket = new WebSocketCtor(wsUrl, 'graphql-transport-ws');
        } catch {
          socket = new WebSocketCtor(wsUrl);
        }
        ws = socket;

        socket.onopen = () => {
          if (unsubscribed || this.isDestroyed) {
            subscription.unsubscribe();
            return;
          }
          try {
            socket.send(JSON.stringify({ type: 'connection_init' }));
            socket.send(
              JSON.stringify({
                id: subId,
                type: 'subscribe',
                payload: {
                  query: options.query,
                  variables,
                },
              })
            );
          } catch (err) {
            this.handleError(options.onError, err);
          }
        };

        socket.onmessage = (event: MessageEvent) => {
          if (unsubscribed || this.isDestroyed) return;
          try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'next' || data.type === 'data') {
              const payload = data.payload ?? data.data;
              options.onData(payload);
            } else if (data.type === 'error') {
              const errPayload = data.payload ?? data.errors;
              const errMsg = typeof errPayload === 'string' ? errPayload : JSON.stringify(errPayload);
              this.handleError(options.onError, new Error(errMsg));
            }
          } catch (err) {
            this.handleError(options.onError, err);
          }
        };

        socket.onerror = (_event: Event) => {
          if (unsubscribed || this.isDestroyed) return;
          this.handleError(options.onError, new Error(`GraphQL subscription WebSocket error on ${this.endpoint}`));
        };

        socket.onclose = () => {
          if (!unsubscribed && !this.isDestroyed) {
            subscription.unsubscribe();
          }
        };
      } catch (err) {
        this.handleError(options.onError, err);
      }
    } else {
      const fetchFn = typeof fetch !== 'undefined' ? fetch : (globalThis as unknown as { fetch?: typeof fetch }).fetch;
      if (typeof fetchFn === 'function' && typeof AbortController !== 'undefined') {
        abortController = new AbortController();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          ...options.headers,
        };

        fetchFn(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: options.query, variables }),
          signal: abortController.signal,
        })
          .then(async (response: Response) => {
            if (unsubscribed || this.isDestroyed) return;
            if (!response.ok) {
              this.handleError(options.onError, new Error(`GraphQL subscription HTTP error: ${response.status}`));
              return;
            }
            if (response.body && typeof response.body.getReader === 'function') {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              while (!unsubscribed && !this.isDestroyed) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') break;
                    try {
                      const parsed = JSON.parse(dataStr);
                      options.onData(parsed.data ?? parsed);
                    } catch {
                      // Ignore malformed line
                    }
                  }
                }
              }
            }
          })
          .catch((err: unknown) => {
            const isAbort = err instanceof Error && err.name === 'AbortError';
            if (!unsubscribed && !this.isDestroyed && !isAbort) {
              this.handleError(options.onError, err);
            }
          });
      }
    }

    return subscription;
  }

  getSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  cleanup(): void {
    this.isDestroyed = true;
    for (const sub of Array.from(this.activeSubscriptions)) {
      sub.unsubscribe();
    }
    this.activeSubscriptions.clear();
  }

  private getWebSocketCtor(): (new (url: string | URL, protocols?: string | string[]) => WebSocket) | null {
    if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis && typeof (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket === 'function') {
      return (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket ?? null;
    }
    if (typeof WebSocket !== 'undefined' && typeof WebSocket === 'function') {
      return WebSocket;
    }
    return null;
  }

  private getWsUrl(endpoint: string): string {
    if (endpoint.startsWith('https://')) {
      return 'wss://' + endpoint.slice(8);
    }
    if (endpoint.startsWith('http://')) {
      return 'ws://' + endpoint.slice(7);
    }
    return endpoint;
  }

  private handleError(onError: ((err: Error) => void) | undefined, err: unknown): void {
    if (onError && typeof onError === 'function') {
      try {
        onError(err instanceof Error ? err : new Error(String(err)));
      } catch {
        // Prevent uncaught errors from user error handlers
      }
    }
  }
}
