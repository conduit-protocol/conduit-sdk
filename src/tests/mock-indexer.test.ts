import { describe, it, expect } from 'vitest'
import { createMockIndexer } from '../mock-indexer.js'

describe('createMockIndexer (#607)', () => {
  it('returns canned data for a matching query name', async () => {
    const indexer = createMockIndexer({
      responses: {
        GetStreams: { data: { streams: [{ id: '1', amount: '100' }] } },
      },
    })

    const result = await indexer.query({
      query: 'query GetStreams { streams { id } }',
    }) as { streams: Array<{ id: string }> }

    expect(result.streams).toHaveLength(1)
    expect(result.streams[0]!.id).toBe('1')
    indexer.cleanup()
  })

  it('returns default response when no query name matches', async () => {
    const indexer = createMockIndexer({
      responses: { GetStreams: { data: { streams: [] } } },
      defaultResponse: { data: { unknown: true } },
    })

    const result = await indexer.query({
      query: 'query GetSomethingElse { things { id } }',
    }) as { unknown?: boolean }

    expect(result.unknown).toBe(true)
    indexer.cleanup()
  })

  it('throws on GraphQL errors in the mock response', async () => {
    const indexer = createMockIndexer({
      responses: {
        FailingQuery: {
          errors: [{ message: 'Field nonexistent not found' }],
        },
      },
    })

    await expect(
      indexer.query({ query: 'query FailingQuery { nonexistent }' }),
    ).rejects.toThrow(/Field nonexistent not found/)
    indexer.cleanup()
  })

  it('simulates latency when configured', async () => {
    const indexer = createMockIndexer({
      responses: { Slow: { data: { ok: true } } },
      latencyMs: 50,
    })

    const start = Date.now()
    await indexer.query({ query: 'query Slow { ok }' })
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(40)
    indexer.cleanup()
  })

  it('returns null when no responses configured', async () => {
    const indexer = createMockIndexer({})

    const result = await indexer.query({ query: 'query Test { x }' })
    expect(result).toBeNull()
    indexer.cleanup()
  })
})
