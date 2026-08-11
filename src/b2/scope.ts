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
  listBuckets(options?: {
    bucketId?: string
    bucketName?: string
  }): Promise<readonly TBucket[]>
}

/**
 * A lister whose buckets carry a name, which resolving one by name requires.
 * Separate from ScopedBucketLister because listing needs no field at all.
 */
export interface ScopedBucketFinder<TBucket extends { readonly name: string }>
  extends ScopedBucketLister<TBucket> {}

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

/**
 * Resolves one bucket by name without ever making a request B2 would reject.
 *
 * Replaces B2Client.getBucket, which falls back to an UNFILTERED listBuckets
 * when its filtered lookup misses (dist/client.js:139-143). That fallback 401s
 * for a bucket-restricted key, so every "no such bucket" became "unauthorized"
 * and BucketNotFoundError became unreachable. See plan 010.
 *
 * The restricted branch deliberately does NOT send the caller's bucketName to
 * B2: asking a restricted key about a bucket it is not allowed to see is
 * exactly the request that fails. Filtering by the key's OWN allowed id always
 * succeeds, and the name is compared here on the single bucket that comes back.
 *
 * Returns null for a bucket that does not exist AND for one this key cannot
 * see. That conflation is intentional: telling a caller a bucket exists but is
 * off-limits would leak the account's shape to a key scoped away from it.
 */
export async function getVisibleBucket<TBucket extends { readonly name: string }>(
  client: ScopedBucketFinder<TBucket>,
  bucketName: string,
): Promise<TBucket | null> {
  const allowedBucketId = client.accountInfo.getAllowedBucketId()

  if (allowedBucketId === null) {
    const [match] = await client.listBuckets({ bucketName })
    return match ?? null
  }

  const [allowed] = await client.listBuckets({ bucketId: allowedBucketId })
  return allowed !== undefined && allowed.name === bucketName ? allowed : null
}
