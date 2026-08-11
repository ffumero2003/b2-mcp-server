import { describe, expect, it } from 'vitest'
import {
  MAX_KEYS,
  listKeys,
  type ApplicationKeyLike,
  type KeyLister,
} from '../src/b2/keys.js'

const NOW = new Date('2026-06-01T00:00:00.000Z')
const BUCKET_ID = 'ddf8f3f77965792b9efc001b'

function key(overrides: Partial<ApplicationKeyLike> = {}): ApplicationKeyLike {
  return {
    keyName: 'file-ops',
    applicationKeyId: '005d837959bec0b0000000099',
    capabilities: ['listFiles', 'readFiles', 'writeFiles'],
    expirationTimestamp: null,
    bucketIds: null,
    namePrefix: null,
    options: [],
    ...overrides,
  }
}

async function* iterate<T>(items: readonly T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item
  }
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(
  keys: readonly ApplicationKeyLike[],
  buckets: readonly { id: string; name: string }[] = [
    { id: BUCKET_ID, name: 'felipe-prompt-gate' },
  ],
  allowedBucketId: string | null = null,
): KeyLister {
  return {
    accountInfo: { getAllowedBucketId: () => allowedBucketId },
    paginateKeys: () => iterate(keys),
    listBuckets: async () => buckets,
  }
}

describe('listKeys - mapping', () => {
  it('maps every summary field from one key', async () => {
    const { keys } = await listKeys(
      fakeClient([
        key({
          keyName: 'ops',
          applicationKeyId: 'id-1',
          capabilities: ['listFiles'],
          namePrefix: 'logs/',
          options: ['s3'],
        }),
      ]),
      NOW,
    )

    expect(keys[0]).toEqual({
      keyName: 'ops',
      applicationKeyId: 'id-1',
      capabilities: ['listFiles'],
      expiresAt: null,
      expired: false,
      bucketNames: [],
      bucketIds: [],
      namePrefix: 'logs/',
      options: ['s3'],
    })
  })

  it('emits NO applicationKey field even when the source object carries one', async () => {
    // The guard that the mapper enumerates its output rather than spreading the
    // SDK object. If a future SDK adds a secret to the list response, it must
    // not reach a client through here.
    const withSecret = {
      ...key(),
      applicationKey: 'SUPER-SECRET-VALUE',
    } as unknown as ApplicationKeyLike

    const { keys } = await listKeys(fakeClient([withSecret]), NOW)

    expect(keys[0]).not.toHaveProperty('applicationKey')
    expect(JSON.stringify(keys)).not.toContain('SUPER-SECRET-VALUE')
  })

  it('excludes the deprecated singular bucketId field', async () => {
    const withDeprecated = {
      ...key({ bucketIds: [BUCKET_ID] }),
      bucketId: BUCKET_ID,
    } as unknown as ApplicationKeyLike

    const { keys } = await listKeys(fakeClient([withDeprecated]), NOW)

    expect(keys[0]).not.toHaveProperty('bucketId')
    expect(keys[0]!.bucketIds).toEqual([BUCKET_ID])
  })

  it('sorts keys by keyName given unsorted input', async () => {
    const { keys } = await listKeys(
      fakeClient([key({ keyName: 'zulu' }), key({ keyName: 'alpha' }), key({ keyName: 'mike' })]),
      NOW,
    )

    expect(keys.map((k) => k.keyName)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('passes namePrefix and options through', async () => {
    const { keys } = await listKeys(
      fakeClient([key({ namePrefix: 'archive/2026/', options: ['s3', 'other'] })]),
      NOW,
    )

    expect(keys[0]!.namePrefix).toBe('archive/2026/')
    expect(keys[0]!.options).toEqual(['s3', 'other'])
  })
})

describe('listKeys - expiry', () => {
  it('converts expirationTimestamp to ISO 8601', async () => {
    const { keys } = await listKeys(
      fakeClient([key({ expirationTimestamp: Date.UTC(2027, 0, 2) })]),
      NOW,
    )

    expect(keys[0]!.expiresAt).toBe('2027-01-02T00:00:00.000Z')
  })

  it('reports expiresAt null for a key that never expires', async () => {
    const { keys } = await listKeys(fakeClient([key({ expirationTimestamp: null })]), NOW)

    expect(keys[0]!.expiresAt).toBeNull()
  })

  it('is not expired when expiry is in the future', async () => {
    const { keys } = await listKeys(
      fakeClient([key({ expirationTimestamp: NOW.getTime() + 86_400_000 })]),
      NOW,
    )

    expect(keys[0]!.expired).toBe(false)
  })

  it('is expired when expiry is in the past', async () => {
    const { keys } = await listKeys(
      fakeClient([key({ expirationTimestamp: NOW.getTime() - 86_400_000 })]),
      NOW,
    )

    expect(keys[0]!.expired).toBe(true)
  })

  it('is not expired when the key never expires', async () => {
    const { keys } = await listKeys(fakeClient([key({ expirationTimestamp: null })]), NOW)

    expect(keys[0]!.expired).toBe(false)
  })
})

describe('listKeys - bucket restrictions', () => {
  it('resolves bucketIds to bucketNames', async () => {
    const { keys } = await listKeys(fakeClient([key({ bucketIds: [BUCKET_ID] })]), NOW)

    expect(keys[0]!.bucketNames).toEqual(['felipe-prompt-gate'])
    expect(keys[0]!.bucketIds).toEqual([BUCKET_ID])
  })

  it('keeps the id and omits a name when a bucket id does not resolve', async () => {
    // A deleted bucket, or one this key cannot see. Inventing a name would lie;
    // dropping the id would hide a restriction that still applies.
    const { keys } = await listKeys(fakeClient([key({ bucketIds: ['gone-bucket-id'] })]), NOW)

    expect(keys[0]!.bucketIds).toEqual(['gone-bucket-id'])
    expect(keys[0]!.bucketNames).toEqual([])
  })

  it('reports empty arrays for an unrestricted key', async () => {
    const { keys } = await listKeys(fakeClient([key({ bucketIds: null })]), NOW)

    expect(keys[0]!.bucketIds).toEqual([])
    expect(keys[0]!.bucketNames).toEqual([])
  })
})

describe('listKeys - listing', () => {
  it('returns an empty list for an account with no keys', async () => {
    const listing = await listKeys(fakeClient([]), NOW)

    expect(listing.keys).toEqual([])
    expect(listing.truncated).toBe(false)
  })

  it('is not truncated when the count lands exactly on MAX_KEYS', async () => {
    const many = Array.from({ length: MAX_KEYS }, (_, i) => key({ keyName: `k${i}` }))

    const listing = await listKeys(fakeClient(many), NOW)

    expect(listing.keys).toHaveLength(MAX_KEYS)
    expect(listing.truncated).toBe(false)
  })

  it('sets truncated once past MAX_KEYS', async () => {
    const many = Array.from({ length: MAX_KEYS + 5 }, (_, i) => key({ keyName: `k${i}` }))

    const listing = await listKeys(fakeClient(many), NOW)

    expect(listing.keys).toHaveLength(MAX_KEYS)
    expect(listing.truncated).toBe(true)
  })

  // Added by 009. This tool is reachable by a bucket-restricted key that DOES
  // carry listKeys, and resolving names through an unfiltered listing would 401
  // before any key was mapped.
  it('resolves bucket names for a restricted key without an unfiltered listing', async () => {
    const client = fakeClient([key({ bucketIds: [BUCKET_ID] })], undefined, BUCKET_ID)

    const { keys } = await listKeys(client, NOW)

    expect(keys[0]!.bucketNames).toEqual(['felipe-prompt-gate'])
    expect(keys[0]!.bucketIds).toEqual([BUCKET_ID])
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: KeyLister = {
      accountInfo: { getAllowedBucketId: () => null },
      paginateKeys: () => iterate([]),
      listBuckets: async () => {
        throw new Error('bad auth token')
      },
    }

    await expect(listKeys(failing)).rejects.toThrow('bad auth token')
  })
})
