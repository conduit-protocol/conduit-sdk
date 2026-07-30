/**
 * GraphQLIndexer.subscribe() has two entirely separate transports — a
 * WebSocket (graphql-transport-ws) path and an SSE/fetch fallback used when
 * no WebSocket constructor is available — and neither had any test coverage
 * beyond construction/cleanup bookkeeping. This file exercises the message
 * lifecycle of both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

// ── WebSocket transport ──────────────────────────────────────────────────

function createMockWs() {
  const mock = {
    readyState: 0,
    sent: [] as string[],
    send: vi.fn((data: string) => {
      mock.sent.push(data);
    }),
    close: vi.fn(),
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as (() => void) | null,
  };
  return mock;
}

describe('GraphQLIndexer.subscribe() — WebSocket transport', () => {
  let mockWs: ReturnType<typeof createMockWs>;
  let wsCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWs = createMockWs();
    wsCtor = vi.fn(function (this: unknown) {
      return mockWs;
    });
    (globalThis as any).WebSocket = wsCtor;
  });

  afterEach(() => {
    delete (globalThis as any).WebSocket;
  });

  it('derives a wss:// URL from an https:// endpoint', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {} });

    expect(wsCtor).toHaveBeenCalledWith('wss://indexer.streamfi.io/graphql', 'graphql-transport-ws');
    indexer.cleanup();
  });

  it('derives a ws:// URL from an http:// endpoint', () => {
    const indexer = new GraphQLIndexer('http://localhost:4000/graphql');
    indexer.subscribe({ query: 'subscription { x }', onData: () => {} });

    expect(wsCtor).toHaveBeenCalledWith('ws://localhost:4000/graphql', 'graphql-transport-ws');
    indexer.cleanup();
  });

  it('sends connection_init then subscribe with the query and variables on open', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { streamUpdated { id } }',
      variables: { streamId: '1' },
      onData: () => {},
    });

    mockWs.readyState = 1;
    mockWs.onopen!();

    expect(mockWs.sent).toHaveLength(2);
    expect(JSON.parse(mockWs.sent[0]!)).toEqual({ type: 'connection_init' });
    const subscribeMsg = JSON.parse(mockWs.sent[1]!);
    expect(subscribeMsg.type).toBe('subscribe');
    expect(subscribeMsg.payload).toEqual({
      query: 'subscription { streamUpdated { id } }',
      variables: { streamId: '1' },
    });

    indexer.cleanup();
  });

  it('delivers "next" and "data" messages to onData', () => {
    const onData = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    mockWs.onmessage!({ data: JSON.stringify({ type: 'next', payload: { id: '1' } }) });
    mockWs.onmessage!({ data: JSON.stringify({ type: 'data', data: { id: '2' } }) });

    expect(onData).toHaveBeenNthCalledWith(1, { id: '1' });
    expect(onData).toHaveBeenNthCalledWith(2, { id: '2' });

    indexer.cleanup();
  });

  it('routes "error" messages to onError instead of onData', () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData, onError });

    mockWs.onmessage!({ data: JSON.stringify({ type: 'error', payload: 'boom' }) });

    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));

    indexer.cleanup();
  });

  it('ignores malformed JSON messages without throwing', () => {
    const onData = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    expect(() => mockWs.onmessage!({ data: 'not json' })).not.toThrow();
    expect(onData).not.toHaveBeenCalled();

    indexer.cleanup();
  });

  it('reports a connection error via onError on socket error', () => {
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    mockWs.onerror!({});

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(endpoint) }));

    indexer.cleanup();
  });

  it('swallows exceptions thrown by the caller-supplied onError handler', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError: () => {
        throw new Error('handler blew up');
      },
    });

    expect(() => mockWs.onerror!({})).not.toThrow();

    indexer.cleanup();
  });

  it('sends a "complete" message and closes the socket on unsubscribe()', () => {
    const indexer = new GraphQLIndexer(endpoint);
    const sub = indexer.subscribe({ query: 'subscription { x }', onData: () => {} });
    mockWs.readyState = 1;

    sub.unsubscribe();

    const completeMsg = JSON.parse(mockWs.sent[0]!);
    expect(completeMsg.type).toBe('complete');
    expect(mockWs.close).toHaveBeenCalledTimes(1);
    expect(indexer.getSubscriptionCount()).toBe(0);

    // Idempotent — a second call must not send/close again or throw.
    sub.unsubscribe();
    expect(mockWs.close).toHaveBeenCalledTimes(1);
  });

  it('auto-unsubscribes when the socket closes unexpectedly', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {} });
    expect(indexer.getSubscriptionCount()).toBe(1);

    mockWs.onclose!();

    expect(indexer.getSubscriptionCount()).toBe(0);
  });
});

// ── SSE / fetch fallback transport (used when no WebSocket is available) ──

function sseBodyFromLines(lines: string[]): { getReader: () => any } {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= lines.length) return { value: undefined, done: true };
        const chunk = encoder.encode(lines[i] + '\n');
        i += 1;
        return { value: chunk, done: false };
      },
    }),
  };
}

describe('GraphQLIndexer.subscribe() — SSE fallback transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).WebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses "data:" lines and delivers the payload to onData', async () => {
    const onData = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBodyFromLines([
        'data: {"data":{"streamUpdated":{"id":"1"}}}',
        '',
        'data: [DONE]',
      ]),
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    // Let the async read loop drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(onData).toHaveBeenCalledWith({ streamUpdated: { id: '1' } });
    indexer.cleanup();
  });

  it('ignores lines that are not SSE data lines and malformed JSON payloads', async () => {
    const onData = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBodyFromLines([
        ': heartbeat',
        'data: not-json',
        'data: {"data":{"ok":true}}',
      ]),
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    await new Promise((r) => setTimeout(r, 10));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith({ ok: true });
    indexer.cleanup();
  });

  it('reports a non-ok HTTP response via onError', async () => {
    const onError = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('503') }));
    indexer.cleanup();
  });

  it('does not report an error when the fetch is aborted by unsubscribe()', async () => {
    const onError = vi.fn();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const indexer = new GraphQLIndexer(endpoint);
    const sub = indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });
    sub.unsubscribe();

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a non-abort fetch rejection via onError', async () => {
    const onError = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'network down' }));
    indexer.cleanup();
  });
});
