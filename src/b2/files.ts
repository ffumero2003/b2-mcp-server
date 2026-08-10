/** Default number of files returned when the caller does not ask for a count. */
export const DEFAULT_LIMIT = 100

/**
 * Hard ceiling on files per call. Well under B2's own 10000 because the binding
 * constraint is how much fits in a model's context window, not the API.
 */
export const MAX_LIMIT = 1000

/** A file flattened to plain serializable data for the MCP boundary. */
export interface FileSummary {
  readonly fileName: string
  readonly fileId: string
  readonly contentLength: number
  readonly contentType: string
  readonly uploadedAt: string
}

/** One page of files, and whether B2 has more beyond it. */
export interface FileListing {
  readonly files: FileSummary[]
  readonly truncated: boolean
  readonly nextFileName: string | null
}

/** The fields this module reads off an SDK FileVersion. */
export interface FileVersionLike {
  readonly fileName: string
  readonly fileId: string
  readonly contentLength: number
  readonly contentType: string
  readonly uploadTimestamp: number
}

/** The subset of a Bucket handle this module needs: listing one page of names. */
export interface FileLister {
  listFileNames(options?: { prefix?: string; pageSize?: number }): Promise<{
    readonly files: readonly FileVersionLike[]
    readonly nextFileName: string | null
  }>
}

/** The subset of B2Client this module needs: resolving a bucket by name. */
export interface BucketFinder {
  getBucket(bucketName: string): Promise<FileLister | null>
}

/**
 * Raised when the named bucket does not exist in the account.
 * Change this if bucket lookup grows failure modes callers must tell apart.
 */
export class BucketNotFoundError extends Error {
  constructor(bucketName: string) {
    super(`No bucket named ${bucketName} in this account`)
    this.name = 'BucketNotFoundError'
  }
}

/** Flattens one SDK file version into serializable data. */
function toSummary(file: FileVersionLike): FileSummary {
  return {
    fileName: file.fileName,
    fileId: file.fileId,
    contentLength: file.contentLength,
    contentType: file.contentType,
    // Epoch milliseconds are unreadable in an AI's answer; ISO 8601 is not.
    uploadedAt: new Date(file.uploadTimestamp).toISOString(),
  }
}

/** Forces a caller-supplied count into the allowed range instead of erroring. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
}

/**
 * Lists one page of current files in a bucket, as plain data sorted by name.
 *
 * Deliberately does not follow nextFileName: walking a large bucket costs a
 * transaction per page and can return far more than a context window holds. The
 * caller is told what it did not see via `truncated`. Change this when a
 * genuine "list everything" mode is needed.
 *
 * @throws BucketNotFoundError when no bucket has that name. Returning an empty
 * list instead would read as "the bucket is empty", which is a wrong answer
 * rather than an error.
 */
export async function listFiles(
  client: BucketFinder,
  options: { bucketName: string; prefix?: string; limit?: number },
): Promise<FileListing> {
  const bucket = await client.getBucket(options.bucketName)
  if (!bucket) {
    throw new BucketNotFoundError(options.bucketName)
  }

  const page = await bucket.listFileNames({
    prefix: options.prefix,
    pageSize: clampLimit(options.limit),
  })

  return {
    files: page.files
      .map(toSummary)
      .sort((a, b) => a.fileName.localeCompare(b.fileName)),
    // Taken from the SDK's own signal rather than inferred from a full page,
    // which would be wrong whenever a page lands exactly on the limit.
    truncated: page.nextFileName !== null,
    nextFileName: page.nextFileName,
  }
}
