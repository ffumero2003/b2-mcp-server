import { describe, expect, it, vi } from 'vitest'
import {
  BucketNotFoundError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  listFiles,
  type BucketFinder,
  type FileVersionLike,
} from '../src/b2/files.js'

/** Jan 2 2024 00:00:00 UTC, as epoch ms -- the shape B2 actually returns. */
const TIMESTAMP = Date.UTC(2024, 0, 2)

/**
 * Builds a FileVersion-shaped record. A real one carries many more fields
 * (accountId, action, contentSha1, fileInfo, legalHold...); the extras are here
 * so the mapper is proven to DROP them rather than pass the record through.
 */
function version(fileName: string, overrides: Partial<FileVersionLike> = {}): FileVersionLike {
  return {
    fileName,
    fileId: `id-${fileName}`,
    contentLength: 10,
    contentType: 'text/plain',
    uploadTimestamp: TIMESTAMP,
    accountId: 'acct',
    action: 'upload',
    fileInfo: {},
    ...overrides,
  } as unknown as FileVersionLike
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(
  files: FileVersionLike[],
  nextFileName: string | null = null,
): BucketFinder & { listFileNames: ReturnType<typeof vi.fn> } {
  const listFileNames = vi.fn(async () => ({ files, nextFileName }))
  return { getBucket: async () => ({ listFileNames }), listFileNames }
}

describe('listFiles', () => {
  it('maps exactly the five summary fields and drops the rest', async () => {
    const result = await listFiles(fakeClient([version('a.txt')]), {
      bucketName: 'bucket',
    })

    expect(result.files).toEqual([
      {
        fileName: 'a.txt',
        fileId: 'id-a.txt',
        contentLength: 10,
        contentType: 'text/plain',
        uploadedAt: '2024-01-02T00:00:00.000Z',
      },
    ])
    expect(Object.keys(result.files[0]!)).toEqual([
      'fileName',
      'fileId',
      'contentLength',
      'contentType',
      'uploadedAt',
    ])
  })

  it('sorts by fileName given unsorted input', async () => {
    const result = await listFiles(
      fakeClient([version('zulu.txt'), version('alpha.txt'), version('mike.txt')]),
      { bucketName: 'bucket' },
    )

    expect(result.files.map((f) => f.fileName)).toEqual([
      'alpha.txt',
      'mike.txt',
      'zulu.txt',
    ])
  })

  it('converts the epoch-ms upload timestamp to ISO 8601', async () => {
    const result = await listFiles(
      fakeClient([version('a.txt', { uploadTimestamp: Date.UTC(2020, 5, 15, 12, 30) })]),
      { bucketName: 'bucket' },
    )

    expect(result.files[0]!.uploadedAt).toBe('2020-06-15T12:30:00.000Z')
  })

  it('forwards prefix to the SDK unchanged', async () => {
    const client = fakeClient([])
    await listFiles(client, { bucketName: 'bucket', prefix: 'logs/2024/' })

    expect(client.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'logs/2024/' }),
    )
  })

  it('applies DEFAULT_LIMIT when no limit is given', async () => {
    const client = fakeClient([])
    await listFiles(client, { bucketName: 'bucket' })

    expect(client.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: DEFAULT_LIMIT }),
    )
  })

  it('clamps a limit above MAX_LIMIT down to MAX_LIMIT', async () => {
    const client = fakeClient([])
    await listFiles(client, { bucketName: 'bucket', limit: 5000 })

    expect(client.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: MAX_LIMIT }),
    )
  })

  it('reports truncated when B2 returns a continuation token', async () => {
    const result = await listFiles(fakeClient([version('a.txt')], 'b.txt'), {
      bucketName: 'bucket',
    })

    expect(result.truncated).toBe(true)
    expect(result.nextFileName).toBe('b.txt')
  })

  it('is not truncated when the page lands exactly on the limit', async () => {
    // The reason truncated reads nextFileName instead of files.length === limit:
    // a full page is not evidence of more files.
    const client = fakeClient([version('a.txt'), version('b.txt')], null)
    const result = await listFiles(client, { bucketName: 'bucket', limit: 2 })

    expect(result.files).toHaveLength(2)
    expect(result.truncated).toBe(false)
    expect(result.nextFileName).toBeNull()
  })

  it('throws BucketNotFoundError naming the bucket when it does not exist', async () => {
    const missing: BucketFinder = { getBucket: async () => null }

    await expect(listFiles(missing, { bucketName: 'no-such-bucket' })).rejects.toThrow(
      BucketNotFoundError,
    )
    await expect(listFiles(missing, { bucketName: 'no-such-bucket' })).rejects.toThrow(
      /no-such-bucket/,
    )
  })

  it('returns an empty, untruncated listing for an empty bucket', async () => {
    const result = await listFiles(fakeClient([]), { bucketName: 'bucket' })

    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: BucketFinder = {
      getBucket: async () => ({
        listFileNames: async () => {
          throw new Error('bad auth token')
        },
      }),
    }

    await expect(listFiles(failing, { bucketName: 'bucket' })).rejects.toThrow(
      'bad auth token',
    )
  })
})
