import { describe, expect, it } from 'vitest'
import { listVisibleBuckets, type ScopedBucketLister } from '../src/b2/scope.js'

/** A bucket reduced to what these cases care about. */
interface TestBucket {
  readonly id: string
  readonly name: string
}

/**
 * Records the options every listBuckets call received, because WHAT was passed
 * is the whole point here: `{}` is unfiltered on the wire and 401s for a
 * restricted key, while omitted options and `{bucketId}` are the two correct
 * calls. A fake that only counted calls would miss that entirely.
 */
function recordingClient(
  allowedBucketId: string | null,
  buckets: TestBucket[] = [],
): ScopedBucketLister<TestBucket> & { calls: ({ bucketId?: string } | undefined)[] } {
  const calls: ({ bucketId?: string } | undefined)[] = []
  return {
    calls,
    accountInfo: { getAllowedBucketId: () => allowedBucketId },
    listBuckets: async (options?: { bucketId?: string }) => {
      calls.push(options)
      return buckets
    },
  }
}

describe('listVisibleBuckets', () => {
  it('filters by the allowed bucket id when the key is restricted', async () => {
    const client = recordingClient('bucket-restricted', [
      { id: 'bucket-restricted', name: 'only-mine' },
    ])

    const result = await listVisibleBuckets(client)

    expect(client.calls).toEqual([{ bucketId: 'bucket-restricted' }])
    expect(result.buckets).toEqual([{ id: 'bucket-restricted', name: 'only-mine' }])
  })

  // DECOY, per CLAUDE.md > Protected files. An empty options object reaches B2
  // as an unfiltered list_buckets and returns the same 401 this plan fixed.
  // Remove this and `listBuckets({})` passes every other test in the repo.
  it('does not send an empty options object for a restricted key', async () => {
    const client = recordingClient('bucket-restricted')

    await listVisibleBuckets(client)

    expect(client.calls[0]).not.toEqual({})
    expect(client.calls[0]).toHaveProperty('bucketId', 'bucket-restricted')
  })

  it('calls with no options at all when the key is unrestricted', async () => {
    const client = recordingClient(null, [
      { id: 'id-a', name: 'alpha' },
      { id: 'id-b', name: 'bravo' },
    ])

    const result = await listVisibleBuckets(client)

    expect(client.calls).toEqual([undefined])
    expect(result.buckets).toHaveLength(2)
  })

  it('reports the scope it applied', async () => {
    await expect(listVisibleBuckets(recordingClient('bucket-restricted'))).resolves.toMatchObject({
      scopedToBucketId: 'bucket-restricted',
    })
    await expect(listVisibleBuckets(recordingClient(null))).resolves.toMatchObject({
      scopedToBucketId: null,
    })
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: ScopedBucketLister<TestBucket> = {
      accountInfo: { getAllowedBucketId: () => null },
      listBuckets: async () => {
        throw new Error('bad auth token')
      },
    }

    await expect(listVisibleBuckets(failing)).rejects.toThrow('bad auth token')
  })
})
