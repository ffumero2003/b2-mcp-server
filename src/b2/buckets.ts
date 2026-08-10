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
 * The subset of B2Client this module needs: something that can list buckets.
 * Change this when a bucket operation beyond listing moves into this module.
 */
export interface BucketLister {
  listBuckets(): Promise<readonly BucketHandle[]>
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
 * Lists the account's buckets as plain data, sorted by name so two runs
 * produce identical, diffable output.
 *
 * The client is a parameter rather than something this function fetches, which
 * is what makes it testable with no network and no credentials. Errors from
 * the SDK propagate untouched; turning them into a tool error is the server
 * layer's job. Change this when the tool needs to filter or paginate.
 */
export async function listBuckets(client: BucketLister): Promise<BucketSummary[]> {
  const buckets = await client.listBuckets()
  return buckets
    .map(toSummary)
    .sort((a, b) => a.bucketName.localeCompare(b.bucketName))
}
