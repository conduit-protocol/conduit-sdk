import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

describe('GraphQLIndexer', () => {
  const endpoint = 'https://indexer.streamfi.io/graphql';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws for empty endpoint', () => {
      expect(() => new GraphQLIndexer('')).toThrow('endpoint must be a non-empty string');
    });

    it('throws for whitespace-only endpoint', () => {
      expect(() => new GraphQLIndexer('   ')).toThrow('endpoint must be a non-empty string');
    });

    it('accepts valid endpoint', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(indexer).toBeInstanceOf(GraphQLIndexer);
      indexer.cleanup();
    });
  });

  describe('query', () => {
    it('throws if destroyed', async () => {
      const indexer = new GraphQLIndexer(endpoint);
      indexer.cleanup();
      await expect(indexer.query({ query: '{ test }' })).rejects.toThrow('has been destroyed');
    });

    it('throws for null options', async () => {
      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query(null as any)).rejects.toThrow('cannot be null or undefined');
      indexer.cleanup();
    });

    it('throws for empty query string', async () => {
      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query({ query: '' })).rejects.toThrow('cannot be null or empty');
      indexer.cleanup();
    });

    it('throws for null query string', async () => {
      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query({ query: null as any })).rejects.toThrow('cannot be null or empty');
      indexer.cleanup();
    });

    it('accepts null variables via default', async () => {
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      const indexer = new GraphQLIndexer(endpoint);
      const result = await indexer.query({ query: '{ test }', variables: null as any });
      expect(result).toEqual({});
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });

    it('throws for non-object variables', async () => {
      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query({ query: '{ test }', variables: 42 as any })).rejects.toThrow('must be an object');
      indexer.cleanup();
    });

    it('throws if fetch is unavailable', async () => {
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = undefined;
      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query({ query: '{ test }' })).rejects.toThrow('Fetch API is not available');
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });

    it('performs POST request and returns data', async () => {
      const data = { data: { ok: true } };
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => data,
      } as Response);

      const indexer = new GraphQLIndexer(endpoint);
      const result = await indexer.query({ query: '{ test }', variables: { limit: 5 } });
      expect(result).toEqual(data);
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });

    it('uses custom headers', async () => {
      const origFetch = (globalThis as any).fetch;
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      (globalThis as any).fetch = fetchFn;

      const indexer = new GraphQLIndexer(endpoint);
      await indexer.query({ query: '{ test }', headers: { Authorization: 'Bearer tok' } });
      expect(fetchFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });

    it('throws on HTTP error', async () => {
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      } as Response);

      const indexer = new GraphQLIndexer(endpoint);
      await expect(indexer.query({ query: '{ test }' })).rejects.toThrow('status 400');
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });

    it('defaults variables to empty object', async () => {
      const origFetch = (globalThis as any).fetch;
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      (globalThis as any).fetch = fetchFn;

      const indexer = new GraphQLIndexer(endpoint);
      await indexer.query({ query: '{ test }' });
      expect(fetchFn).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({
          body: expect.stringContaining('"variables":{}'),
        }),
      );
      indexer.cleanup();
      (globalThis as any).fetch = origFetch;
    });
  });

  describe('subscribe', () => {
    it('throws if destroyed', () => {
      const indexer = new GraphQLIndexer(endpoint);
      indexer.cleanup();
      expect(() => indexer.subscribe({ query: 'sub { x }', onData: () => {} })).toThrow('has been destroyed');
    });

    it('throws for null options', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(() => indexer.subscribe(null as any)).toThrow('cannot be null or undefined');
      indexer.cleanup();
    });

    it('throws for empty query', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(() => indexer.subscribe({ query: '', onData: () => {} } as any)).toThrow('cannot be null or empty');
      indexer.cleanup();
    });

    it('throws if onData is not a function', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(() => indexer.subscribe({ query: 'sub { x }', onData: null as any })).toThrow('must be a function');
      indexer.cleanup();
    });

    it('accepts null variables (defaulted to {})', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(() =>
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, variables: null as any }),
      ).not.toThrow();
      expect(indexer.getSubscriptionCount()).toBe(1);
      indexer.cleanup();
    });

    it('throws for non-object variables', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(() =>
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, variables: 42 as any }),
      ).toThrow('must be an object');
      indexer.cleanup();
    });

    it('tracks and returns subscription count', () => {
      const indexer = new GraphQLIndexer(endpoint);
      expect(indexer.getSubscriptionCount()).toBe(0);

      const sub1 = indexer.subscribe({ query: 'sub { a }', onData: () => {} });
      expect(indexer.getSubscriptionCount()).toBe(1);

      const sub2 = indexer.subscribe({ query: 'sub { b }', onData: () => {} });
      expect(indexer.getSubscriptionCount()).toBe(2);

      sub1.unsubscribe();
      expect(indexer.getSubscriptionCount()).toBe(1);

      sub2.unsubscribe();
      expect(indexer.getSubscriptionCount()).toBe(0);

      indexer.cleanup();
    });

    it('cleanup unsubscribes all and rejects further subscribe calls', () => {
      const indexer = new GraphQLIndexer(endpoint);
      indexer.subscribe({ query: 'sub { a }', onData: () => {} });
      indexer.subscribe({ query: 'sub { b }', onData: () => {} });
      expect(indexer.getSubscriptionCount()).toBe(2);

      indexer.cleanup();
      expect(indexer.getSubscriptionCount()).toBe(0);
      expect(() => indexer.subscribe({ query: 'sub { c }', onData: () => {} })).toThrow('has been destroyed');
    });

    it('multiple unsubscribe calls are idempotent', () => {
      const indexer = new GraphQLIndexer(endpoint);
      const sub = indexer.subscribe({ query: 'sub { a }', onData: () => {} });
      sub.unsubscribe();
      sub.unsubscribe();
      sub.unsubscribe();
      expect(indexer.getSubscriptionCount()).toBe(0);
      indexer.cleanup();
    });

    describe('WebSocket path', () => {
      function makeWs() {
        return {
          readyState: 0,
          send: vi.fn(),
          close: vi.fn(),
          onopen: null as (() => void) | null,
          onmessage: null as ((e: any) => void) | null,
          onerror: null as ((e: any) => void) | null,
          onclose: null as (() => void) | null,
        };
      }

      function stubGlobalWebSocket(ws: ReturnType<typeof makeWs>) {
        const orig = (globalThis as any).WebSocket;
        const ctor = function (this: any, _url: string, _protocols?: string) {
          return ws;
        };
        ctor.prototype = {};
        (globalThis as any).WebSocket = ctor as any;
        return orig;
      }

      it('uses WebSocket when available', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData: () => {} });
        expect(ws.send).toBeDefined();
        sub.unsubscribe();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('calls onopen and sends init messages', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: vi.fn() });

        expect(ws.onopen).toBeDefined();
        ws.onopen!();

        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('connection_init'));
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('subscribe'));
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('forwards onmessage data events', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });

        ws.onmessage!({ data: JSON.stringify({ type: 'next', payload: { value: 42 } }) });
        expect(onData).toHaveBeenCalledWith({ value: 42 });
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('handles data type events', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });

        ws.onmessage!({ data: JSON.stringify({ type: 'data', data: { val: 'test' } }) });
        expect(onData).toHaveBeenCalledWith({ val: 'test' });
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('calls onError on error events', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });

        ws.onmessage!({ data: JSON.stringify({ type: 'error', payload: 'something broke' }) });
        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('calls onError on socket onerror', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });

        ws.onerror!({});
        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('ignores messages after unsubscribe', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData });
        sub.unsubscribe();

        ws.onmessage!({ data: JSON.stringify({ type: 'next', payload: { val: 1 } }) });
        expect(onData).not.toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('ignores messages after indexer cleanup', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        indexer.cleanup();

        ws.onmessage!({ data: JSON.stringify({ type: 'next', payload: { val: 1 } }) });
        expect(onData).not.toHaveBeenCalled();
        (globalThis as any).WebSocket = orig;
      });

      it('sends complete message on unsubscribe when socket is OPEN', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData: () => {} });

        ws.readyState = 1;
        sub.unsubscribe();
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('complete'));
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('ignores socket close errors on unsubscribe', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        ws.close = vi.fn(() => { throw new Error('close error'); });
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData: () => {} });
        expect(() => sub.unsubscribe()).not.toThrow();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('handles onmessage with object data (already parsed)', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });

        ws.onmessage!({ data: { type: 'next', payload: { val: 1 } } });
        expect(onData).toHaveBeenCalledWith({ val: 1 });
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('ignores unknown message types', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });

        ws.onmessage!({ data: JSON.stringify({ type: 'unknown' }) });
        expect(onData).not.toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('ignores null data in onmessage', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });

        ws.onmessage!({ data: JSON.stringify(null) });
        expect(onData).not.toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('handles onmessage parse errors gracefully', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const onData = vi.fn();
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData, onError });

        ws.onmessage!({ data: 'not json {{{' });
        expect(onError).toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('auto-unsubscribes on socket close when not already unsubscribed', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {} });

        expect(indexer.getSubscriptionCount()).toBe(1);
        ws.onclose!();
        expect(indexer.getSubscriptionCount()).toBe(0);
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('does not auto-unsubscribe on close if already destroyed', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {} });
        indexer.cleanup();

        ws.onclose!();
        expect(indexer.getSubscriptionCount()).toBe(0);
        (globalThis as any).WebSocket = orig;
      });

      it('onopen does nothing if already unsubscribed', () => {
        const ws = makeWs();
        const orig = stubGlobalWebSocket(ws);
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData: vi.fn() });

        sub.unsubscribe();
        ws.send.mockClear();
        ws.onopen!();
        expect(ws.send).not.toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('falls back to no-protocol WebSocket if protocol constructor throws', () => {
        let callCount = 0;
        const ws = makeWs();
        const orig = (globalThis as any).WebSocket;
        const ctor = function (this: any, _url: string, _protocols?: string) {
          callCount++;
          if (arguments.length > 1) {
            throw new Error('protocol not supported');
          }
          return ws;
        };
        ctor.prototype = {};
        (globalThis as any).WebSocket = ctor as any;
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });
        expect(callCount).toBe(2);
        sub.unsubscribe();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('calls onError if socket.send throws in onopen', () => {
        const ws = makeWs();
        ws.send = vi.fn().mockImplementation(() => { throw new Error('send failed'); });
        const orig = stubGlobalWebSocket(ws);
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });
        ws.onopen!();
        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });

      it('calls onError if WebSocket constructor throws entirely', () => {
        const orig = (globalThis as any).WebSocket;
        const ctor = function () {
          throw new Error('constructor failed');
        };
        ctor.prototype = {};
        (globalThis as any).WebSocket = ctor as any;
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });
        expect(onError).toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).WebSocket = orig;
      });
    });

    describe('HTTP SSE fallback path', () => {
      beforeEach(() => {
        (globalThis as any).WebSocket = undefined;
      });

      afterEach(() => {
        (globalThis as any).WebSocket = globalThis.WebSocket;
      });

      it('calls onError when fetch rejects', async () => {
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });
        await new Promise(r => setTimeout(r, 50));
        expect(onError).toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('calls onError on HTTP error response', async () => {
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
        const onError = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData: () => {}, onError });
        await new Promise(r => setTimeout(r, 50));
        expect(onError).toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('processes SSE data events', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('data: {"val":1}\n\n'), done: false })
            .mockResolvedValueOnce({ value: encoder.encode('data: {"val":2}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(2);
        expect(onData).toHaveBeenCalledWith({ val: 1 });
        expect(onData).toHaveBeenCalledWith({ val: 2 });
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('skips SSE lines without data: prefix', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('event: test\ndata: {"val":1}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith({ val: 1 });
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('handles malformed JSON in SSE stream gracefully', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('data: not json\n\ndata: {"val":2}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith({ val: 2 });
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('stops on [DONE] in SSE stream', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('data: {"val":1}\n\ndata: [DONE]\n\ndata: {"val":2}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith({ val: 1 });
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('exits SSE loop on stream done', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('data: {"val":1}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(1);
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('unsubscribe aborts the fetch and does not crash', async () => {
        const encoder = new TextEncoder();
        const reader = {
          read: vi.fn()
            .mockResolvedValueOnce({ value: encoder.encode('data: {"val":1}\n\n'), done: false })
            .mockResolvedValue({ value: undefined, done: true }),
        };
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        const sub = indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).toHaveBeenCalledTimes(1);
        expect(() => sub.unsubscribe()).not.toThrow();
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });

      it('does not enter SSE loop if response has no body reader', async () => {
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = vi.fn().mockResolvedValue({
          ok: true,
          body: null,
        } as unknown as Response);
        const onData = vi.fn();
        const indexer = new GraphQLIndexer(endpoint);
        indexer.subscribe({ query: 'sub { x }', onData });
        await new Promise(r => setTimeout(r, 50));
        expect(onData).not.toHaveBeenCalled();
        indexer.cleanup();
        (globalThis as any).fetch = origFetch;
      });
    });

    describe('getWebSocketCtor', () => {
      it('returns constructor from globalThis.WebSocket when available', () => {
        const orig = (globalThis as any).WebSocket;
        const fake = function () {};
        (globalThis as any).WebSocket = fake as any;
        try {
          const indexer = new GraphQLIndexer(endpoint);
          const ctor = (indexer as any).getWebSocketCtor();
          expect(ctor).toBe(fake);
          indexer.cleanup();
        } finally {
          (globalThis as any).WebSocket = orig;
        }
      });

      it('returns null when WebSocket is not available', () => {
        const orig = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = undefined;
        try {
          const indexer = new GraphQLIndexer(endpoint);
          const ctor = (indexer as any).getWebSocketCtor();
          expect(ctor).toBeNull();
          indexer.cleanup();
        } finally {
          (globalThis as any).WebSocket = orig;
        }
      });
    });

    describe('getWsUrl', () => {
      it('converts https to wss', () => {
        const indexer = new GraphQLIndexer('https://example.com/graphql');
        expect((indexer as any).getWsUrl('https://example.com/graphql')).toBe('wss://example.com/graphql');
        indexer.cleanup();
      });

      it('converts http to ws', () => {
        const indexer = new GraphQLIndexer('http://example.com/graphql');
        expect((indexer as any).getWsUrl('http://example.com/graphql')).toBe('ws://example.com/graphql');
        indexer.cleanup();
      });

      it('returns endpoint as-is for unknown protocol', () => {
        const indexer = new GraphQLIndexer('ws://example.com/graphql');
        expect((indexer as any).getWsUrl('ws://example.com/graphql')).toBe('ws://example.com/graphql');
        indexer.cleanup();
      });
    });

    describe('handleError', () => {
      it('calls onError with Error instance', () => {
        const indexer = new GraphQLIndexer(endpoint);
        const onError = vi.fn();
        (indexer as any).handleError(onError, 'string error');
        expect(onError).toHaveBeenCalledWith(expect.any(Error));

        (indexer as any).handleError(onError, new Error('real error'));
        expect(onError).toHaveBeenCalledWith(new Error('real error'));
        indexer.cleanup();
      });

      it('does not throw if onError throws', () => {
        const indexer = new GraphQLIndexer(endpoint);
        const onError = vi.fn().mockImplementation(() => { throw new Error('onError blew up'); });
        expect(() => (indexer as any).handleError(onError, 'test')).not.toThrow();
        indexer.cleanup();
      });

      it('does nothing if onError is not a function', () => {
        const indexer = new GraphQLIndexer(endpoint);
        expect(() => (indexer as any).handleError(null, 'test')).not.toThrow();
        expect(() => (indexer as any).handleError(undefined, 'test')).not.toThrow();
        indexer.cleanup();
      });
    });
  });
});
