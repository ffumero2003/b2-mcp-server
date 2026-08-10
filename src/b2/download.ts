import { open, rename, rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { DOWNLOAD_ROOT_VAR, resolveNewFilePath } from '../path-fence.js'
import { BucketNotFoundError } from './files.js'

/** What a download produced, flattened for the MCP boundary. */
export interface DownloadReceipt {
  readonly fileName: string
  readonly localPath: string
  readonly bucketName: string
  readonly contentLength: number
  readonly contentType: string
  readonly fileId: string
  readonly sha1: string | null
  readonly downloadedAt: string
}

/** The header fields this module reads off a DownloadResult. */
export interface DownloadHeadersLike {
  readonly contentType: string
  readonly contentLength: number
  readonly contentSha1: string | null
  readonly fileId: string
  readonly fileName: string
}

/** The subset of a Bucket handle this module needs: streaming a file out. */
export interface DownloadSource {
  download(fileName: string): Promise<{
    readonly headers: DownloadHeadersLike
    readonly body: ReadableStream<Uint8Array>
  }>
}

/** The subset of B2Client this module needs: resolving a bucket by name. */
export interface BucketDownloader {
  getBucket(bucketName: string): Promise<DownloadSource | null>
}

/**
 * Raised when the destination already exists and overwrite was not requested.
 * A local file has no version history, so replacing one destroys data.
 */
export class DestinationExistsError extends Error {
  constructor(localPath: string) {
    super(`Destination already exists, pass overwrite to replace it: ${localPath}`)
    this.name = 'DestinationExistsError'
  }
}

/** Raised when fewer bytes arrived than B2 said the file contains. */
export class IncompleteDownloadError extends Error {
  constructor(expected: number, actual: number) {
    super(`Incomplete download: expected ${expected} bytes, wrote ${actual}`)
    this.name = 'IncompleteDownloadError'
  }
}

/** True when a path exists, without caring what it is. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Streams a body to a file, returning how many bytes landed.
 *
 * Counting here rather than trusting the stream is what makes the
 * contentLength check meaningful.
 */
async function writeBodyToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<number> {
  const handle = await open(path, 'w')
  let written = 0
  try {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        await handle.write(value)
        written += value.byteLength
      }
    }
  } finally {
    await handle.close()
  }
  return written
}

/**
 * Downloads a file from a bucket to local disk and reports what landed.
 *
 * Written atomically: the body streams to a temp file beside the target and is
 * renamed onto it only after arriving complete. The SDK documents that a failed
 * checksum errors the stream AFTER bytes have flowed, so a direct write would
 * leave a truncated file at exactly the path the caller now trusts. On any
 * failure the temp file is removed and the target is left untouched.
 *
 * File CONTENT is never returned -- that would put an arbitrary file into the
 * model's context. Change this when downloads need ranges or versions.
 *
 * @param resolvePath - Defaulted per CLAUDE.md > Established conventions.
 * @throws BucketNotFoundError, DestinationExistsError, IncompleteDownloadError.
 */
export async function downloadFile(
  client: BucketDownloader,
  options: {
    bucketName: string
    fileName: string
    localPath?: string
    overwrite?: boolean
  },
  resolvePath: (candidate: string) => Promise<string> = (candidate) =>
    resolveNewFilePath(candidate, DOWNLOAD_ROOT_VAR),
): Promise<DownloadReceipt> {
  // A B2 file name is attacker-controlled data here, so only its basename is
  // used as a default: "logs/2024/app.log" must not steer where bytes land.
  const requested = options.localPath ?? basename(options.fileName)
  const target = await resolvePath(requested)

  // Checked before any transfer, so a refused call costs no bandwidth.
  if (!options.overwrite && (await exists(target))) {
    throw new DestinationExistsError(requested)
  }

  const bucket = await client.getBucket(options.bucketName)
  if (!bucket) {
    throw new BucketNotFoundError(options.bucketName)
  }

  const { headers, body } = await bucket.download(options.fileName)
  const temp = `${target}.${process.pid}.partial`

  try {
    const written = await writeBodyToFile(body, temp)
    if (written !== headers.contentLength) {
      throw new IncompleteDownloadError(headers.contentLength, written)
    }
    // Same directory, so this is an atomic move rather than a copy.
    await rename(temp, target)
  } catch (error) {
    // Never leave a partial file behind for the caller to mistake for the real one.
    await rm(temp, { force: true })
    throw error
  }

  return {
    fileName: headers.fileName,
    localPath: target,
    bucketName: options.bucketName,
    contentLength: headers.contentLength,
    contentType: headers.contentType,
    fileId: headers.fileId,
    sha1: headers.contentSha1,
    downloadedAt: new Date().toISOString(),
  }
}
