/** Keys returned per call before the listing reports itself truncated. */
export const MAX_KEYS = 1000

/**
 * One application key, flattened for the MCP boundary.
 *
 * Every field is named explicitly and nothing from the SDK response is spread
 * in. That is deliberate here above anywhere else in this project: if a future
 * SDK version adds a secret-bearing field to the list response, it cannot reach
 * a client through this type by accident.
 */
export interface KeySummary {
  readonly keyName: string
  readonly applicationKeyId: string
  readonly capabilities: readonly string[]
  readonly expiresAt: string | null
  readonly expired: boolean
  readonly bucketNames: readonly string[]
  readonly bucketIds: readonly string[]
  readonly namePrefix: string | null
  readonly options: readonly string[]
}

/** A page of keys, and whether the cap stopped the listing short. */
export interface KeyListing {
  readonly keys: KeySummary[]
  readonly truncated: boolean
}

/**
 * The fields this module reads off an SDK ApplicationKey.
 *
 * Note what is absent: there is no secret on this shape, because the B2 list
 * response carries none. Only createKey returns a secret, and this project does
 * not call it.
 */
export interface ApplicationKeyLike {
  readonly keyName: string
  readonly applicationKeyId: string
  readonly capabilities: readonly string[]
  readonly expirationTimestamp: number | null
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly options: readonly string[]
}

/** The subset of B2Client this module needs. */
export interface KeyLister {
  paginateKeys(options?: { pageSize?: number }): AsyncIterableIterator<ApplicationKeyLike>
  listBuckets(): Promise<readonly { readonly id: string; readonly name: string }[]>
}

/**
 * Flattens one key, resolving its bucket restriction to readable names.
 *
 * An id that does not resolve -- a deleted bucket, or one this key cannot see --
 * keeps its place in bucketIds and contributes no name. Inventing a name would
 * be a lie and dropping the id would hide a restriction that still applies.
 *
 * The SDK's deprecated singular bucketId is deliberately not carried over;
 * bucketIds is its documented replacement.
 */
function toSummary(
  key: ApplicationKeyLike,
  bucketNamesById: ReadonlyMap<string, string>,
  now: Date,
): KeySummary {
  const bucketIds = key.bucketIds ?? []

  return {
    keyName: key.keyName,
    applicationKeyId: key.applicationKeyId,
    capabilities: [...key.capabilities],
    expiresAt:
      key.expirationTimestamp === null
        ? null
        : new Date(key.expirationTimestamp).toISOString(),
    // Derived so "which keys have expired" needs no date arithmetic from a model.
    expired: key.expirationTimestamp !== null && key.expirationTimestamp <= now.getTime(),
    bucketNames: bucketIds
      .map((id) => bucketNamesById.get(id))
      .filter((name): name is string => name !== undefined),
    bucketIds: [...bucketIds],
    namePrefix: key.namePrefix,
    options: [...key.options],
  }
}

/**
 * Lists the account's application keys as plain data, sorted by name.
 *
 * The B2 list response contains NO key secrets -- verified against the SDK's
 * ApplicationKey type, which has no such field, unlike the FullApplicationKey
 * that createKey alone returns. This function still enumerates its output
 * rather than passing anything through, so that guarantee does not depend on
 * the SDK never changing.
 *
 * Listing costs one extra call to resolve bucket ids to names, which turns an
 * opaque hex restriction into something a person can read.
 *
 * Change this when keys need filtering, or when a caller wants raw ids only.
 *
 * @param now - Defaulted per CLAUDE.md > Established conventions, so the
 * expired computation is testable without mocking the clock.
 */
export async function listKeys(
  client: KeyLister,
  now: Date = new Date(),
): Promise<KeyListing> {
  const buckets = await client.listBuckets()
  const bucketNamesById = new Map(buckets.map((bucket) => [bucket.id, bucket.name]))

  const keys: KeySummary[] = []
  let truncated = false

  for await (const key of client.paginateKeys({ pageSize: MAX_KEYS })) {
    // Checked before consuming, so exactly MAX_KEYS is a complete listing and
    // MAX_KEYS + 1 is a truncated one.
    if (keys.length >= MAX_KEYS) {
      truncated = true
      break
    }
    keys.push(toSummary(key, bucketNamesById, now))
  }

  keys.sort((a, b) => a.keyName.localeCompare(b.keyName))

  return { keys, truncated }
}
