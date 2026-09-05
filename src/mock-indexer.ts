/**
 * Mock GraphQLIndexer transport for unit testing.
 *
 * #607: Consumers can't unit-test indexer-backed code without stubbing
 * global `fetch`. This provides an in-memory transport that returns
 * canned responses without any network calls.
 *
 * @example
 * import { createMockIndexer } from '@conduit-protocol/sdk';
 *
 * const indexer = createMockIndexer({
 *   responses: {
 *     'GetStreams': { data: { streams: [{ id: '1' }] } },
 *   },
 * });
 *
 * const data = await indexer.query({ query: 'query GetStreams { streams { id } }' });
 */

import { GraphQLIndexer, type GraphQLQueryOptions } from './indexer.js'

export interface MockResponse {
  /** The data to return from query(). Matches body.data in a real GraphQL response. */
  data?: unknown
  /** Optional GraphQL errors to simulate. */
  errors?: Array<{ message: string }>
}

export interface MockIndexerConfig {
  /**
   * Map of query-name-prefix to response. The mock matches the beginning
   * of the query string to find the right entry. If no match is found,
   * a default response (empty data) is returned.
   */
  responses?: Record<string, MockResponse>
  /** Default response when no match is found. */
  defaultResponse?: MockResponse
  /** Simulated network latency in ms. Default 0. */
  latencyMs?: number
}

/**
 * Creates a GraphQLIndexer whose `query()` returns canned data
 * without any network calls. Subscriptions still require a real transport.
 */
export function createMockIndexer(config: MockIndexerConfig = {}): GraphQLIndexer {
  const { responses = {}, defaultResponse = { data: null }, latencyMs = 0 } = config

  const indexer = new GraphQLIndexer('mock://indexer')

  // Override query to return canned data directly — no fetch patching.
  indexer.query = async (options: GraphQLQueryOptions): Promise<unknown> => {
    if (latencyMs > 0) {
      await new Promise(r => setTimeout(r, latencyMs))
    }

    const queryStr = options.query ?? ''
    const match = queryStr.match(/\b(?:query|mutation)\s+(\w+)/)
    const queryName = match?.[1] ?? queryStr.trim().split(/\s|\(/)[0] ?? ''

    const matchKey = Object.keys(responses).find(
      key => queryName.startsWith(key) || queryStr.includes(key),
    )
    const response = matchKey ? responses[matchKey]! : defaultResponse

    if (response.errors && response.errors.length > 0) {
      throw new Error(response.errors.map(e => e.message).join('; '))
    }

    return response.data ?? null
  }

  return indexer
}
