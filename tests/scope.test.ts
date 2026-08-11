import { describe, expect, it } from 'vitest'
import {
  getVisibleBucket,
  listVisibleBuckets,
  type ScopedBucketLister,
} from '../src/b2/scope.js'

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
    listBuckets: async (options?: { bucketId?: string; bucketName?: string }) => {
      calls.push(options)
      // Filters the way B2 does, so "no match" is a real empty result rather
      // than something the fake decided.
      return buckets.filter(
        (b) =>
          (options?.bucketId === undefined || b.id === options.bucketId) &&
          (options?.bucketName === undefined || b.name === options.bucketName),
      )
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

describe('getVisibleBucket', () => {
  const buckets = [
    { id: 'id-a', name: 'alpha' },
    { id: 'id-b', name: 'bravo' },
  ]

  it('finds a bucket by name for an unrestricted key', async () => {
    const client = recordingClient(null, buckets)

    await expect(getVisibleBucket(client, 'bravo')).resolves.toEqual({
      id: 'id-b',
      name: 'bravo',
    })
    expect(client.calls).toEqual([{ bucketName: 'bravo' }])
  })

  // DECOY, per CLAUDE.md > Protected files. A miss must cost exactly ONE call.
  // A second one is the SDK's unfiltered fallback returning -- the whole of
  // plan 010 -- and no other test in the repo counts calls.
  it('returns null for an unknown name in a single call, never a second lookup', async () => {
    const client = recordingClient(null, buckets)

    await expect(getVisibleBucket(client, 'no-such-bucket')).resolves.toBeNull()
    expect(client.calls).toHaveLength(1)
    expect(client.calls).not.toContainEqual(undefined)
  })

  it('finds its own bucket for a restricted key, filtering by the allowed id', async () => {
    const client = recordingClient('id-a', buckets)

    await expect(getVisibleBucket(client, 'alpha')).resolves.toEqual({
      id: 'id-a',
      name: 'alpha',
    })
    expect(client.calls).toEqual([{ bucketId: 'id-a' }])
  })

  it('never asks B2 about a bucket a restricted key may not see', async () => {
    const client = recordingClient('id-a', buckets)

    // bravo exists, but this key is confined to alpha. Sending bucketName=bravo
    // is the request B2 answers with 401, so it must never leave the process.
    await expect(getVisibleBucket(client, 'bravo')).resolves.toBeNull()
    expect(client.calls).toEqual([{ bucketId: 'id-a' }])
    expect(JSON.stringify(client.calls)).not.toContain('bravo')
  })
})
