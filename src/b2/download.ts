import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { IncompleteWriteError, writeStreamAtomically } from '../atomic-write.js'
import { DOWNLOAD_ROOT_VAR, resolveNewFilePath } from '../path-fence.js'
import { BucketNotFoundError } from './files.js'

/**
 * The short-body failure, under the name this module has always used.
 * Aliased rather than renamed so plan 005's callers and tests keep working
 * after the write logic moved to src/atomic-write.ts.
 */
export { IncompleteWriteError as IncompleteDownloadError }

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
  await writeStreamAtomically(body, target, headers.contentLength)

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
