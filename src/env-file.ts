import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Whether a .env file was found and loaded, or simply was not there. */
export type DotEnvStatus = 'loaded' | 'absent'

/**
 * The package root, resolved from this module's own location.
 *
 * Both src/env-file.ts and dist/env-file.js sit exactly one level below the
 * root, so the same "one level up" holds under `npm run dev` and `npm start`.
 * Change this only if the build layout stops being one level deep.
 */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Loads .env from the package root into process.env, if it exists.
 *
 * Resolved against the package root rather than the current working directory
 * because an MCP client launches this server from an arbitrary cwd, where a
 * relative path would silently find nothing. Variables already present in the
 * real environment take precedence over the file, which is what lets an MCP
 * client's env block override .env.
 *
 * Change this when credentials need to come from a second file or a profile.
 *
 * @param root - Directory to look in. Defaulted for testability, so tests can
 * point at a temp directory without touching the real .env.
 * @returns 'loaded' if the file was read, 'absent' if there was none.
 * @throws Any error other than a missing file, so a malformed or unreadable
 * .env is never silently reported as absent.
 */
export function loadDotEnv(root: string = packageRoot()): DotEnvStatus {
  const path = join(root, '.env')

  // Readability is checked with accessSync rather than by catching from
  // loadEnvFile, because loadEnvFile reports an unreadable file as ENOENT --
  // verified against Node 22.19.0. Trusting its errno would silently downgrade
  // "your .env has wrong permissions" to "you have no .env", which is the
  // hardest possible version of that bug to diagnose.
  try {
    accessSync(path, constants.R_OK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent'
    }
    throw error
  }

  process.loadEnvFile(path)
  return 'loaded'
}
