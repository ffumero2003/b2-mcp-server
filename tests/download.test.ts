import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BucketNotFoundError } from '../src/b2/files.js'
import {
  DestinationExistsError,
  IncompleteDownloadError,
  downloadFile,
  type BucketDownloader,
  type DownloadHeadersLike,
} from '../src/b2/download.js'

const BODY = 'hello from b2-mcp-server\n'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'b2-download-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Resolver bound to the temp root, standing in for the real path fence. */
const intoRoot = async (candidate: string): Promise<string> => join(root, candidate)

function headers(overrides: Partial<DownloadHeadersLike> = {}): DownloadHeadersLike {
  return {
    contentType: 'text/plain',
    contentLength: Buffer.byteLength(BODY),
    contentSha1: 'abc123',
    fileId: 'file-id-1',
    fileName: 'hello.txt',
    ...overrides,
  }
}

/** A stream that yields the body in one chunk. */
function bodyStream(text = BODY): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A stream that yields some bytes and then fails, as a checksum error would. */
function failingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial data'))
      controller.error(new Error('ChecksumMismatchError'))
    },
  })
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(
  stream: () => ReadableStream<Uint8Array> = bodyStream,
  head: DownloadHeadersLike = headers(),
): BucketDownloader {
  return {
    getBucket: async () => ({
      download: async () => ({ headers: head, body: stream() }),
    }),
  }
}

/** Any leftover .partial file is the bug this slice exists to prevent. */
function partialFiles(): string[] {
  return readdirSync(root).filter((name) => name.endsWith('.partial'))
}

describe('downloadFile', () => {
  it('writes the body to the target and returns the receipt', async () => {
    const receipt = await downloadFile(
      fakeClient(),
      { bucketName: 'my-bucket', fileName: 'hello.txt' },
      intoRoot,
    )

    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe(BODY)
    expect(receipt).toMatchObject({
      fileName: 'hello.txt',
      localPath: join(root, 'hello.txt'),
      bucketName: 'my-bucket',
      contentLength: Buffer.byteLength(BODY),
      contentType: 'text/plain',
      fileId: 'file-id-1',
      sha1: 'abc123',
    })
    expect(receipt.downloadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('leaves no .partial file behind on success', async () => {
    await downloadFile(fakeClient(), { bucketName: 'b', fileName: 'hello.txt' }, intoRoot)

    expect(partialFiles()).toEqual([])
  })

  it('defaults the destination to the base name, ignoring directories in the B2 name', async () => {
    // A B2 file name is attacker-controlled data: it must not steer the target.
    const receipt = await downloadFile(
      fakeClient(),
      { bucketName: 'b', fileName: 'logs/2024/app.log' },
      intoRoot,
    )

    expect(receipt.localPath).toBe(join(root, 'app.log'))
  })

  it('refuses an existing destination and leaves it untouched', async () => {
    writeFileSync(join(root, 'hello.txt'), 'ORIGINAL')

    await expect(
      downloadFile(fakeClient(), { bucketName: 'b', fileName: 'hello.txt' }, intoRoot),
    ).rejects.toThrow(DestinationExistsError)
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('ORIGINAL')
  })

  it('replaces an existing destination when overwrite is set', async () => {
    writeFileSync(join(root, 'hello.txt'), 'ORIGINAL')

    await downloadFile(
      fakeClient(),
      { bucketName: 'b', fileName: 'hello.txt', overwrite: true },
      intoRoot,
    )

    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe(BODY)
  })

  it('leaves NO file at the target when the stream fails mid-transfer', async () => {
    // The SDK documents that a checksum failure errors the stream after bytes
    // have already flowed. A direct write would leave a truncated file here.
    await expect(
      downloadFile(fakeClient(failingStream), { bucketName: 'b', fileName: 'hello.txt' }, intoRoot),
    ).rejects.toThrow(/ChecksumMismatch/)

    expect(existsSync(join(root, 'hello.txt'))).toBe(false)
    expect(partialFiles()).toEqual([])
  })

  it('does not clobber an existing file when a mid-stream failure happens', async () => {
    writeFileSync(join(root, 'hello.txt'), 'ORIGINAL')

    await expect(
      downloadFile(
        fakeClient(failingStream),
        { bucketName: 'b', fileName: 'hello.txt', overwrite: true },
        intoRoot,
      ),
    ).rejects.toThrow(/ChecksumMismatch/)

    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('ORIGINAL')
    expect(partialFiles()).toEqual([])
  })

  it('rejects a short body and writes nothing to the target', async () => {
    const short = fakeClient(bodyStream, headers({ contentLength: 9999 }))

    await expect(
      downloadFile(short, { bucketName: 'b', fileName: 'hello.txt' }, intoRoot),
    ).rejects.toThrow(IncompleteDownloadError)

    expect(existsSync(join(root, 'hello.txt'))).toBe(false)
    expect(partialFiles()).toEqual([])
  })

  it('throws BucketNotFoundError naming the bucket when it does not exist', async () => {
    const missing: BucketDownloader = { getBucket: async () => null }

    await expect(
      downloadFile(missing, { bucketName: 'no-such-bucket', fileName: 'hello.txt' }, intoRoot),
    ).rejects.toThrow(BucketNotFoundError)
  })

  it('propagates an SDK rejection instead of swallowing it', async () => {
    const failing: BucketDownloader = {
      getBucket: async () => ({
        download: async () => {
          throw new Error('bad auth token')
        },
      }),
    }

    await expect(
      downloadFile(failing, { bucketName: 'b', fileName: 'hello.txt' }, intoRoot),
    ).rejects.toThrow('bad auth token')
  })
})
