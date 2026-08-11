import { describe, expect, it } from 'vitest'
import { listBuckets, type BucketHandle, type BucketLister } from '../src/b2/buckets.js'

/** Builds a Bucket-shaped handle: id and name are flat, bucketType lives on info. */
function handle(id: string, name: string, bucketType = 'allPrivate'): BucketHandle {
  return {
    id,
    name,
    info: { bucketType },
    // A real Bucket carries methods and a client reference. Including one here
    // proves the mapper drops them instead of passing the handle through.
    upload: () => {
      throw new Error('not a serializable field')
    },
  } as unknown as BucketHandle
}

/**
 * Stands in for B2Client with no network and no credentials. allowedBucketId
 * defaults to null, the unrestricted key every earlier case assumed.
 */
function fakeClient(buckets: BucketHandle[], allowedBucketId: string | null = null): BucketLister {
  return {
    accountInfo: { getAllowedBucketId: () => allowedBucketId },
    listBuckets: async () => buckets,
  }
}

describe('listBuckets', () => {
  it('maps handles to exactly the three summary fields', async () => {
    const result = await listBuckets(
      fakeClient([
        handle('id-a', 'alpha', 'allPrivate'),
        handle('id-b', 'bravo', 'allPublic'),
        handle('id-c', 'charlie', 'allPrivate'),
      ]),
    )

    expect(result.buckets).toEqual([
      { bucketId: 'id-a', bucketName: 'alpha', bucketType: 'allPrivate' },
      { bucketId: 'id-b', bucketName: 'bravo', bucketType: 'allPublic' },
      { bucketId: 'id-c', bucketName: 'charlie', bucketType: 'allPrivate' },
    ])
    expect(Object.keys(result.buckets[0]!)).toEqual(['bucketId', 'bucketName', 'bucketType'])
  })

  it('sorts by bucketName given unsorted input', async () => {
    const result = await listBuckets(
      fakeClient([
        handle('id-z', 'zulu'),
        handle('id-a', 'alpha'),
        handle('id-m', 'mike'),
      ]),
    )

    expect(result.buckets.map((b) => b.bucketName)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('returns an empty list when the account has no buckets', async () => {
    await expect(listBuckets(fakeClient([]))).resolves.toEqual({
      buckets: [],
      scopedToBucketId: null,
    })
  })

  it('reports scopedToBucketId null for an unrestricted key', async () => {
    const result = await listBuckets(fakeClient([handle('id-a', 'alpha')]))

    expect(result.scopedToBucketId).toBeNull()
  })

  it('reports the bucket a restricted key is confined to', async () => {
    const result = await listBuckets(fakeClient([handle('id-a', 'alpha')], 'id-a'))

    expect(result.scopedToBucketId).toBe('id-a')
    expect(result.buckets.map((b) => b.bucketName)).toEqual(['alpha'])
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: BucketLister = {
      accountInfo: { getAllowedBucketId: () => null },
      listBuckets: async () => {
        throw new Error('bad auth token')
      },
    }

    await expect(listBuckets(failing)).rejects.toThrow('bad auth token')
  })
})
