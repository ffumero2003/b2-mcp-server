import { BucketNotFoundError } from './files.js'

/**
 * Budget a bucket is measured against when the caller names none.
 *
 * 10 GiB is B2's free storage tier, so the default answers "am I about to start
 * paying?". Policy, so it lives in code rather than the environment: a limit is
 * not a secret (CLAUDE.md > House rules).
 */
export const DEFAULT_BUDGET_BYTES = 10 * 1024 ** 3

/** Fraction of budget at which a bucket is flagged. The Overview's "80%". */
export const OVER_BUDGET_THRESHOLD = 0.8

/** Versions requested per API call. B2 caps this endpoint at 10000. */
export const PAGE_SIZE = 1000

/** Pages scanned per bucket before stopping and saying the scan was capped. */
export const MAX_PAGES_PER_BUCKET = 20

/** What one bucket is using, and how that compares to its budget. */
export interface BucketUsage {
  readonly bucketName: string
  readonly bytesUsed: number
  readonly bytesUsedHuman: string
  readonly versionCount: number
  readonly unfinishedLargeFiles: number
  readonly budgetBytes: number
  readonly percentOfBudget: number
  readonly overThreshold: boolean
  readonly truncated: boolean
}

/** Usage across every bucket scanned. */
export interface UsageReport {
  readonly buckets: BucketUsage[]
  readonly totalBytesUsed: number
  readonly totalBytesUsedHuman: string
  readonly anyTruncated: boolean
}

/** The fields this module reads off an SDK FileVersion. */
export interface VersionLike {
  readonly action: string
  readonly contentLength: number
}

/** The subset of a Bucket handle this module needs. */
export interface UsageBucket {
  readonly name: string
  paginateFileVersions(options?: { pageSize?: number }): AsyncIterableIterator<VersionLike>
  paginateUnfinishedLargeFiles(options?: { pageSize?: number }): AsyncIterableIterator<unknown>
}

/** The subset of B2Client this module needs. */
export interface UsageClient {
  listBuckets(): Promise<readonly UsageBucket[]>
  getBucket(bucketName: string): Promise<UsageBucket | null>
}

/**
 * Whether a version represents bytes B2 is storing and charging for.
 *
 * The five FileAction values, spelled out because getting this wrong silently
 * changes every number this tool reports:
 *   upload - a real object.                      COUNT
 *   copy   - a real object made server-side.     COUNT
 *   hide   - a soft-delete marker, not data.     skip
 *   folder - a virtual directory marker.         skip
 *   start  - a large file begun, never finished. skip, and counted separately:
 *            the billed bytes are its PARTS, which this record does not carry.
 *
 * Change this only if B2 adds an action, and then say which side it falls on.
 */
function isStoredBytes(version: VersionLike): boolean {
  return version.action === 'upload' || version.action === 'copy'
}

/**
 * Renders a byte count in units a person reads.
 *
 * Exists so a model can answer "about 42 MiB" without doing arithmetic on a raw
 * number, which is where invented figures come from.
 */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`
}

/** Counts unfinished large uploads, whose parts are billed but not summed here. */
async function countUnfinished(bucket: UsageBucket): Promise<number> {
  let count = 0
  for await (const _unfinished of bucket.paginateUnfinishedLargeFiles()) {
    count += 1
  }
  return count
}

/**
 * Measures one bucket by walking its file versions.
 *
 * OLD versions are counted, because B2 charges for every version retained: a
 * bucket holding ten revisions of a 1 MB file is using 10 MB, and reporting
 * only the current version would flatter the number.
 *
 * The scan is capped. A capped scan sets truncated rather than presenting a
 * short total as a whole one.
 */
async function measureBucket(
  bucket: UsageBucket,
  budgetBytes: number,
  thresholdPercent: number,
): Promise<BucketUsage> {
  const scanLimit = PAGE_SIZE * MAX_PAGES_PER_BUCKET
  let scanned = 0
  let bytesUsed = 0
  let versionCount = 0
  let truncated = false

  for await (const version of bucket.paginateFileVersions({ pageSize: PAGE_SIZE })) {
    // Checked before consuming, so exactly scanLimit versions is a complete
    // scan and scanLimit + 1 is a truncated one.
    if (scanned >= scanLimit) {
      truncated = true
      break
    }
    scanned += 1

    if (isStoredBytes(version)) {
      bytesUsed += version.contentLength
      versionCount += 1
    }
  }

  const percentOfBudget = Math.round((bytesUsed / budgetBytes) * 1000) / 10

  return {
    bucketName: bucket.name,
    bytesUsed,
    bytesUsedHuman: humanBytes(bytesUsed),
    versionCount,
    unfinishedLargeFiles: await countUnfinished(bucket),
    budgetBytes,
    percentOfBudget,
    overThreshold: percentOfBudget >= thresholdPercent,
    truncated,
  }
}

/**
 * Reports storage used per bucket against a budget.
 *
 * B2 exposes no usage endpoint, so this is computed by summing file versions.
 * The figure EXCLUDES unfinished large-file parts, which B2 does bill for; the
 * count of such uploads is reported beside the bytes so a caller knows what the
 * number leaves out. It is a floor, not a ceiling.
 *
 * Cost: one Class C transaction per 1000 versions per bucket. Scanning every
 * bucket on a large account is the most expensive call this server makes.
 *
 * Change this when per-bucket budgets or part-level accounting are needed.
 *
 * @param options.bucketName - Omit to scan every bucket.
 * @throws BucketNotFoundError when a named bucket does not exist, so a missing
 * bucket never reads as one using zero bytes.
 */
export async function bucketUsage(
  client: UsageClient,
  options: {
    bucketName?: string
    budgetBytes?: number
    thresholdPercent?: number
  } = {},
): Promise<UsageReport> {
  const budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES
  const thresholdPercent = options.thresholdPercent ?? OVER_BUDGET_THRESHOLD * 100

  let targets: readonly UsageBucket[]
  if (options.bucketName === undefined) {
    targets = await client.listBuckets()
  } else {
    const one = await client.getBucket(options.bucketName)
    if (!one) {
      throw new BucketNotFoundError(options.bucketName)
    }
    targets = [one]
  }

  const buckets: BucketUsage[] = []
  for (const bucket of targets) {
    buckets.push(await measureBucket(bucket, budgetBytes, thresholdPercent))
  }
  buckets.sort((a, b) => a.bucketName.localeCompare(b.bucketName))

  const totalBytesUsed = buckets.reduce((sum, b) => sum + b.bytesUsed, 0)

  return {
    buckets,
    totalBytesUsed,
    totalBytesUsedHuman: humanBytes(totalBytesUsed),
    anyTruncated: buckets.some((b) => b.truncated),
  }
}
