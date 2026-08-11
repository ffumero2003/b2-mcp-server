import { listVisibleBuckets, type ScopedBucketLister } from './scope.js'

/**
 * A bucket flattened to plain serializable data.
 *
 * The SDK's Bucket is a live handle carrying methods and a client reference,
 * none of which can cross the MCP boundary. This is what does.
 */
export interface BucketSummary {
  readonly bucketId: string
  readonly bucketName: string
  readonly bucketType: string
}

/**
 * The subset of a Bucket handle this module reads. Declared structurally so a
 * test fake satisfies it without constructing a real authorized client.
 */
export interface BucketHandle {
  readonly id: string
  readonly name: string
  readonly info: { readonly bucketType: string }
}

/**
 * The subset of B2Client this module needs: something that can list buckets
 * within the authorized key's scope. Change this when a bucket operation beyond
 * listing moves into this module.
 */
export type BucketLister = ScopedBucketLister<BucketHandle>

/**
 * A bucket listing plus the scope it was taken under.
 *
 * scopedToBucketId is non-null when the key is restricted to one bucket, which
 * means the list is NOT the whole account. A bare array had nowhere to say
 * that, which is why this shape exists (Partial results announce themselves).
 */
export interface BucketListing {
  readonly buckets: BucketSummary[]
  readonly scopedToBucketId: string | null
}

/** Flattens one live Bucket handle into serializable data. */
function toSummary(bucket: BucketHandle): BucketSummary {
  return {
    bucketId: bucket.id,
    bucketName: bucket.name,
    bucketType: bucket.info.bucketType,
  }
}

/**
 * Lists the buckets this key can see as plain data, sorted by name so two runs
 * produce identical, diffable output.
 *
 * Goes through listVisibleBuckets rather than calling the client directly: an
 * unfiltered listing 401s for a bucket-restricted key, and the result has to
 * say when it covered one bucket rather than the account.
 *
 * The client is a parameter rather than something this function fetches, which
 * is what makes it testable with no network and no credentials. Errors from
 * the SDK propagate untouched; turning them into a tool error is the server
 * layer's job. Change this when the tool needs caller-supplied filters or
 * pagination.
 */
export async function listBuckets(client: BucketLister): Promise<BucketListing> {
  const { buckets, scopedToBucketId } = await listVisibleBuckets(client)
  return {
    buckets: buckets
      .map(toSummary)
      .sort((a, b) => a.bucketName.localeCompare(b.bucketName)),
    scopedToBucketId,
  }
}
