import { describe, expect, it } from 'vitest'
import { BucketNotFoundError } from '../src/b2/files.js'
import {
  DEFAULT_BUDGET_BYTES,
  MAX_PAGES_PER_BUCKET,
  PAGE_SIZE,
  bucketUsage,
  humanBytes,
  type UsageBucket,
  type UsageClient,
  type VersionLike,
} from '../src/b2/usage.js'

const MIB = 1024 ** 2

/** A FileVersion-shaped record. action is what decides whether it is counted. */
function version(action: string, contentLength: number): VersionLike {
  return { action, contentLength }
}

/** Yields the given items as the SDK's paginator would. */
async function* iterate<T>(items: readonly T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item
  }
}

function fakeBucket(
  name: string,
  versions: readonly VersionLike[],
  unfinished: readonly unknown[] = [],
): UsageBucket {
  return {
    name,
    paginateFileVersions: () => iterate(versions),
    paginateUnfinishedLargeFiles: () => iterate(unfinished),
  }
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(buckets: readonly UsageBucket[]): UsageClient {
  return {
    listBuckets: async () => buckets,
    getBucket: async (name) => buckets.find((b) => b.name === name) ?? null,
  }
}

/** The single-bucket report, for the many cases that only look at one. */
async function measure(
  versions: readonly VersionLike[],
  options: Parameters<typeof bucketUsage>[1] = {},
  unfinished: readonly unknown[] = [],
) {
  const report = await bucketUsage(fakeClient([fakeBucket('b', versions, unfinished)]), options)
  return report.buckets[0]!
}

describe('bucketUsage - what counts as stored bytes', () => {
  it('sums upload versions', async () => {
    const usage = await measure([version('upload', 100), version('upload', 250)])

    expect(usage.bytesUsed).toBe(350)
    expect(usage.versionCount).toBe(2)
  })

  it('includes copy versions, which are real stored objects', async () => {
    const usage = await measure([version('upload', 100), version('copy', 400)])

    expect(usage.bytesUsed).toBe(500)
    expect(usage.versionCount).toBe(2)
  })

  it('EXCLUDES hide markers, which are soft-delete flags and not data', async () => {
    const usage = await measure([version('upload', 100), version('hide', 999)])

    expect(usage.bytesUsed).toBe(100)
    expect(usage.versionCount).toBe(1)
  })

  it('EXCLUDES folder markers, which are virtual', async () => {
    const usage = await measure([version('upload', 100), version('folder', 999)])

    expect(usage.bytesUsed).toBe(100)
  })

  it('EXCLUDES start records and reports them as unfinishedLargeFiles instead', async () => {
    // The billed bytes of an unfinished upload are its PARTS, which this record
    // does not carry. Summing it would report a number B2 never stored.
    const usage = await measure([version('upload', 100), version('start', 5_000_000)], {}, [
      { fileId: 'unfinished-1' },
    ])

    expect(usage.bytesUsed).toBe(100)
    expect(usage.unfinishedLargeFiles).toBe(1)
  })

  it('counts OLD versions of the same name, because B2 bills for every one', async () => {
    const usage = await measure([
      version('upload', 1000),
      version('upload', 1000),
      version('upload', 1000),
    ])

    expect(usage.bytesUsed).toBe(3000)
  })

  it('reports zero for an empty bucket without erroring', async () => {
    const usage = await measure([])

    expect(usage.bytesUsed).toBe(0)
    expect(usage.versionCount).toBe(0)
    expect(usage.overThreshold).toBe(false)
  })
})

describe('bucketUsage - budget and threshold', () => {
  it('computes percentOfBudget against the default budget', async () => {
    const usage = await measure([version('upload', DEFAULT_BUDGET_BYTES / 4)])

    expect(usage.budgetBytes).toBe(DEFAULT_BUDGET_BYTES)
    expect(usage.percentOfBudget).toBe(25)
  })

  it('honours a caller-supplied budgetBytes', async () => {
    const usage = await measure([version('upload', 500)], { budgetBytes: 1000 })

    expect(usage.budgetBytes).toBe(1000)
    expect(usage.percentOfBudget).toBe(50)
  })

  it('is not over threshold just below it', async () => {
    const usage = await measure([version('upload', 799)], { budgetBytes: 1000 })

    expect(usage.percentOfBudget).toBe(79.9)
    expect(usage.overThreshold).toBe(false)
  })

  it('is over threshold at and above it', async () => {
    const usage = await measure([version('upload', 800)], { budgetBytes: 1000 })

    expect(usage.percentOfBudget).toBe(80)
    expect(usage.overThreshold).toBe(true)
  })

  it('honours a caller-supplied thresholdPercent', async () => {
    const usage = await measure([version('upload', 500)], {
      budgetBytes: 1000,
      thresholdPercent: 50,
    })

    expect(usage.overThreshold).toBe(true)
  })
})

describe('bucketUsage - bucket selection', () => {
  it('scans every bucket and sorts them by name', async () => {
    const client = fakeClient([
      fakeBucket('zulu', [version('upload', 300)]),
      fakeBucket('alpha', [version('upload', 100)]),
      fakeBucket('mike', [version('upload', 200)]),
    ])

    const report = await bucketUsage(client)

    expect(report.buckets.map((b) => b.bucketName)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('totals bytes across every bucket', async () => {
    const client = fakeClient([
      fakeBucket('a', [version('upload', 100)]),
      fakeBucket('b', [version('upload', 250)]),
    ])

    const report = await bucketUsage(client)

    expect(report.totalBytesUsed).toBe(350)
  })

  it('scans only the named bucket when one is given', async () => {
    const client = fakeClient([
      fakeBucket('a', [version('upload', 100)]),
      fakeBucket('b', [version('upload', 999)]),
    ])

    const report = await bucketUsage(client, { bucketName: 'a' })

    expect(report.buckets).toHaveLength(1)
    expect(report.totalBytesUsed).toBe(100)
  })

  it('raises BucketNotFoundError rather than reporting zero bytes', async () => {
    // A missing bucket must never read as one using nothing.
    const client = fakeClient([fakeBucket('a', [])])

    await expect(bucketUsage(client, { bucketName: 'nope' })).rejects.toThrow(
      BucketNotFoundError,
    )
  })
})

describe('bucketUsage - scan cap', () => {
  const cap = PAGE_SIZE * MAX_PAGES_PER_BUCKET

  it('is not truncated when the version count lands exactly on the cap', async () => {
    const usage = await measure(Array.from({ length: cap }, () => version('upload', 1)))

    expect(usage.truncated).toBe(false)
    expect(usage.bytesUsed).toBe(cap)
  })

  it('sets truncated and stops once past the cap', async () => {
    const usage = await measure(Array.from({ length: cap + 50 }, () => version('upload', 1)))

    expect(usage.truncated).toBe(true)
    expect(usage.bytesUsed).toBe(cap)
  })

  it('reports anyTruncated when a single bucket was capped', async () => {
    const client = fakeClient([
      fakeBucket('small', [version('upload', 1)]),
      fakeBucket('huge', Array.from({ length: cap + 1 }, () => version('upload', 1))),
    ])

    const report = await bucketUsage(client)

    expect(report.anyTruncated).toBe(true)
  })
})

describe('bucketUsage - reporting', () => {
  it('renders human-readable sizes', async () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(2 * MIB)).toBe('2.0 MiB')
    expect(humanBytes(3 * 1024 ** 3)).toBe('3.0 GiB')
  })

  it('reports the total in human-readable form too', async () => {
    const client = fakeClient([fakeBucket('a', [version('upload', 5 * MIB)])])

    const report = await bucketUsage(client)

    expect(report.totalBytesUsedHuman).toBe('5.0 MiB')
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: UsageClient = {
      listBuckets: async () => {
        throw new Error('bad auth token')
      },
      getBucket: async () => null,
    }

    await expect(bucketUsage(failing)).rejects.toThrow('bad auth token')
  })
})
