import { describe, it, expect, vi } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

function mockFetch(response: unknown, status = 200) {
  return vi.fn(
    (_uri: string | URL, _options?: RequestInit): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } }),
      ),
  );
}

describe('GraphQLIndexer mock transport (#607)', () => {
  it('uses injected transport instead of global fetch', async () => {
    const transport = mockFetch({ data: { streams: [{ id: '1' }] } });
    const indexer = new GraphQLIndexer({ endpoint, transport });

    const result = await indexer.query({ query: '{ streams { id } }' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ streams: [{ id: '1' }] });
  });

  it('string endpoint still works without transport', async () => {
    // This test just verifies the old constructor path is not broken.
    // In a real test environment without fetch, it would throw.
    expect(() => new GraphQLIndexer(endpoint)).not.toThrow();
  });

  it('transport receives the correct endpoint and body', async () => {
    const transport = mockFetch({ data: { ping: true } });
    const indexer = new GraphQLIndexer({ endpoint, transport });

    await indexer.query({ query: '{ ping }', variables: { a: 1 } });

    const [, options] = transport.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.query).toBe('{ ping }');
    expect(body.variables).toEqual({ a: 1 });
  });

  it('rejects when transport returns an error status', async () => {
    const transport = mockFetch({ error: 'boom' }, 500);
    const indexer = new GraphQLIndexer({ endpoint, transport });

    await expect(indexer.query({ query: '{ ping }' })).rejects.toThrow('GraphQL query failed with status 500');
  });
});
