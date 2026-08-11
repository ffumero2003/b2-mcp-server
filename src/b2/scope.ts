/**
 * Bucket listing that honours the authorized key's own restriction.
 *
 * B2 rejects an unfiltered b2_list_buckets from a bucket-restricted key with a
 * 401, and the listAllBucketNames capability does NOT exempt it. The filtered
 * form works, so a restricted key must ask for its one bucket by id rather than
 * asking for everything. Every whole-account bucket listing in this project
 * goes through here; see CLAUDE.md > What NOT to do for the scar.
 */

/** What a bucket listing covered, and the bucket it was narrowed to (or null). */
export interface VisibleBuckets<TBucket> {
  readonly buckets: readonly TBucket[]
  readonly scopedToBucketId: string | null
}

/**
 * The subset of B2Client this module needs: the authorized key's restriction,
 * and a bucket listing that accepts a bucketId filter. Declared structurally so
 * a test fake satisfies it without an authorized client (CLAUDE.md >
 * Established conventions).
 *
 * Generic in the bucket type because each caller reads different fields off a
 * Bucket handle, and this module reads none of them.
 */
export interface ScopedBucketLister<TBucket> {
  readonly accountInfo: {
    getAllowedBucketId(): string | null
  }
  listBuckets(options?: { bucketId?: string }): Promise<readonly TBucket[]>
}

/**
 * Lists the buckets this key is actually allowed to see, filtering by the key's
 * own allowed bucket id when it has one.
 *
 * Returns the scope alongside the buckets so callers can report a narrowed
 * listing as narrowed, per Established conventions > Partial results announce
 * themselves. A caller that ignored the scope would present one bucket as the
 * whole account.
 *
 * Change this if B2 starts issuing keys restricted to SEVERAL buckets: the SDK
 * already exposes getAllowedBucketIds() (plural), but the console cannot create
 * such a key today, so reading the singular is the honest choice.
 */
export async function listVisibleBuckets<TBucket>(
  client: ScopedBucketLister<TBucket>,
): Promise<VisibleBuckets<TBucket>> {
  const scopedToBucketId = client.accountInfo.getAllowedBucketId()

  // The two calls differ by more than an argument: passing {} instead of
  // omitting options is unfiltered on the wire and 401s exactly as before.
  const buckets =
    scopedToBucketId === null
      ? await client.listBuckets()
      : await client.listBuckets({ bucketId: scopedToBucketId })

  return { buckets, scopedToBucketId }
}
