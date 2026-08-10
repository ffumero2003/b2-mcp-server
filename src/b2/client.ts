import { B2Client } from '@backblaze-labs/b2-sdk'
import type { B2Config } from '../config.js'

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
