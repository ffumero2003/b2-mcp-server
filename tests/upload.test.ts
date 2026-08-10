import { describe, expect, it, vi } from 'vitest'
import { BucketNotFoundError } from '../src/b2/files.js'
import { uploadFile, type BucketUploader, type UploadedVersion } from '../src/b2/upload.js'

const TIMESTAMP = Date.UTC(2024, 0, 2)

/** A stand-in for the resolved path, so these cases never touch a real disk. */
const RESOLVED = '/permitted/root/report.pdf'
const passThrough = async (): Promise<string> => RESOLVED
const fakeSource = async (): Promise<unknown> => ({ marker: 'source' })

/** Builds the FileVersion-shaped record B2 returns from an upload. */
function version(overrides: Partial<UploadedVersion> = {}): UploadedVersion {
  return {
    fileId: 'file-id-1',
    fileName: 'report.pdf',
    contentLength: 2048,
    contentType: 'application/pdf',
    uploadTimestamp: TIMESTAMP,
    ...overrides,
  }
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(result = version()): BucketUploader & { upload: ReturnType<typeof vi.fn> } {
  const upload = vi.fn(async () => result)
  return { getBucket: async () => ({ upload }), upload }
}

describe('uploadFile', () => {
  it('returns exactly the receipt fields', async () => {
    const result = await uploadFile(
      fakeClient(),
      { bucketName: 'my-bucket', localPath: 'report.pdf' },
      passThrough,
      fakeSource,
    )

    expect(result).toEqual({
      fileId: 'file-id-1',
      fileName: 'report.pdf',
      bucketName: 'my-bucket',
      contentLength: 2048,
      contentType: 'application/pdf',
      uploadedAt: '2024-01-02T00:00:00.000Z',
    })
  })

  it('defaults the stored name to the basename, never the full local path', async () => {
    const client = fakeClient()
    await uploadFile(
      client,
      { bucketName: 'b', localPath: RESOLVED },
      passThrough,
      fakeSource,
    )

    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'report.pdf' }),
    )
  })

  it('lets an explicit fileName override the basename', async () => {
    const client = fakeClient()
    await uploadFile(
      client,
      { bucketName: 'b', localPath: RESOLVED, fileName: 'archive/2024/report.pdf' },
      passThrough,
      fakeSource,
    )

    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'archive/2024/report.pdf' }),
    )
  })

  it('omits contentType so B2 auto-detects when none is given', async () => {
    const client = fakeClient()
    await uploadFile(
      client,
      { bucketName: 'b', localPath: RESOLVED },
      passThrough,
      fakeSource,
    )

    expect(client.upload.mock.calls[0]![0]).not.toHaveProperty('contentType')
  })

  it('forwards contentType when one is given', async () => {
    const client = fakeClient()
    await uploadFile(
      client,
      { bucketName: 'b', localPath: RESOLVED, contentType: 'text/csv' },
      passThrough,
      fakeSource,
    )

    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'text/csv' }),
    )
  })

  it('refuses a forbidden path before contacting B2 at all', async () => {
    // Path policy runs first so a rejected upload costs no network call.
    const client = fakeClient()
    const rejecting = async (): Promise<string> => {
      throw new Error('Path is outside the permitted upload directory: /etc/hosts')
    }

    await expect(
      uploadFile(client, { bucketName: 'b', localPath: '/etc/hosts' }, rejecting, fakeSource),
    ).rejects.toThrow(/outside the permitted upload directory/)
    expect(client.upload).not.toHaveBeenCalled()
  })

  it('throws BucketNotFoundError naming the bucket when it does not exist', async () => {
    const missing: BucketUploader = { getBucket: async () => null }

    await expect(
      uploadFile(
        missing,
        { bucketName: 'no-such-bucket', localPath: RESOLVED },
        passThrough,
        fakeSource,
      ),
    ).rejects.toThrow(BucketNotFoundError)
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: BucketUploader = {
      getBucket: async () => ({
        upload: async () => {
          throw new Error('insufficient capability')
        },
      }),
    }

    await expect(
      uploadFile(failing, { bucketName: 'b', localPath: RESOLVED }, passThrough, fakeSource),
    ).rejects.toThrow('insufficient capability')
  })
})
