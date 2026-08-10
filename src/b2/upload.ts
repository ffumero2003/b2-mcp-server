import { basename } from 'node:path'
import { FileSource } from '@backblaze-labs/b2-sdk'
import { resolveUploadPath } from '../upload-path.js'
import { BucketNotFoundError } from './files.js'

/** What an upload produces, flattened for the MCP boundary. */
export interface UploadReceipt {
  readonly fileId: string
  readonly fileName: string
  readonly bucketName: string
  readonly contentLength: number
  readonly contentType: string
  readonly uploadedAt: string
}

/** The fields this module reads off the FileVersion an upload returns. */
export interface UploadedVersion {
  readonly fileId: string
  readonly fileName: string
  readonly contentLength: number
  readonly contentType: string
  readonly uploadTimestamp: number
}

/** The subset of a Bucket handle this module needs: accepting an upload. */
export interface UploadTarget {
  upload(options: {
    fileName: string
    source: unknown
    contentType?: string
  }): Promise<UploadedVersion>
}

/** The subset of B2Client this module needs: resolving a bucket by name. */
export interface BucketUploader {
  getBucket(bucketName: string): Promise<UploadTarget | null>
}

/**
 * Uploads a local file into a bucket and reports what B2 stored.
 *
 * The local path is confined to the configured upload root BEFORE any network
 * call, and the RESOLVED path is what gets read — re-resolving later would open
 * a time-of-check/time-of-use gap. Change this when uploads accept a source
 * other than a local file.
 *
 * @param resolvePath - Defaulted so tests avoid the real filesystem, and
 * @param createSource - likewise for the SDK's file reader. Both follow
 * CLAUDE.md > Established conventions, Defaulted-collaborator parameter.
 * @throws BucketNotFoundError when the bucket does not exist, so a missing
 * bucket never reads as a failed upload.
 */
export async function uploadFile(
  client: BucketUploader,
  options: {
    bucketName: string
    localPath: string
    fileName?: string
    contentType?: string
  },
  resolvePath: (candidate: string) => Promise<string> = resolveUploadPath,
  createSource: (path: string) => Promise<unknown> = (path) => FileSource.fromPath(path),
): Promise<UploadReceipt> {
  // Path policy first: refuse a forbidden path before spending a network call
  // or touching credentials.
  const localPath = await resolvePath(options.localPath)

  const bucket = await client.getBucket(options.bucketName)
  if (!bucket) {
    throw new BucketNotFoundError(options.bucketName)
  }

  const source = await createSource(localPath)
  const version = await bucket.upload({
    // A local path must not become the B2 object name.
    fileName: options.fileName ?? basename(localPath),
    source,
    // Forwarded only when given, so B2's own b2/x-auto detection stays the
    // default rather than being overridden by a guess.
    ...(options.contentType ? { contentType: options.contentType } : {}),
  })

  return {
    fileId: version.fileId,
    fileName: version.fileName,
    bucketName: options.bucketName,
    contentLength: version.contentLength,
    contentType: version.contentType,
    uploadedAt: new Date(version.uploadTimestamp).toISOString(),
  }
}
