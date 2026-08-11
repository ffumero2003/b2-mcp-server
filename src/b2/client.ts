import { B2Client } from '@backblaze-labs/b2-sdk'
import type { B2Config } from '../config.js'
import { getVisibleBucket } from './scope.js'

/**
 * The authorized client, reused across tool calls. Authorizing once per
 * process keeps every call after the first from paying a round trip.
 */
let cached: B2Client | null = null

/**
 * Returns an authorized B2 client, creating and authorizing one on first use.
 *
 * Authorization is lazy rather than done at server start, so a server launched
 * with bad credentials still starts and reports the failure through a tool
 * result instead of dying before the client can see why. Change this if the
 * server ever needs to serve more than one B2 account per process.
 */
export async function getClient(config: B2Config): Promise<B2Client> {
  if (cached) {
    return cached
  }

  const client = new B2Client({
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
  })

  // Assigned only after authorize resolves, so a failed attempt leaves the
  // cache empty and a later call with fixed credentials can still succeed.
  await client.authorize()

  // Deliberate patch of third-party behavior; do not "clean this up". The SDK's
  // getBucket falls back to an UNFILTERED listBuckets when its filtered lookup
  // misses (dist/client.js:139-143), and B2 answers that with 401 for a
  // bucket-restricted key -- turning every "no such bucket" into "unauthorized"
  // for the very credential .env.example mandates. Overriding here rather than
  // in the five modules that call getBucket keeps their seams and their test
  // fakes untouched, and this is the one place a client is constructed.
  // Safe as an own-property override: B2Client declares all fields publicly and
  // uses no #private fields, so `this` stays bound to the real client. See 010.
  client.getBucket = async (bucketName: string) => getVisibleBucket(client, bucketName)

  cached = client
  return client
}

/**
 * Clears the memoized client. Exists for tests, which would otherwise leak an
 * authorized client between cases through the module cache.
 */
export function resetClient(): void {
  cached = null
}
