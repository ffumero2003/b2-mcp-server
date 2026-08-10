import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Environment variable naming the only directory uploads may READ from. */
export const UPLOAD_ROOT_VAR = 'B2_UPLOAD_ROOT'

/** Environment variable naming the only directory downloads may WRITE to. */
export const DOWNLOAD_ROOT_VAR = 'B2_DOWNLOAD_ROOT'

/**
 * Raised when a root is unset, or is set but unusable.
 *
 * Filesystem access denies by default: a server that reads or writes any path a
 * model names is an exfiltration primitive one way and a vandalism primitive
 * the other. Change this only if tools stop touching local files.
 */
export class RootNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootNotConfiguredError'
  }
}

/**
 * Raised when a candidate path escapes its root or is the wrong kind of thing.
 * Change this if the containment rule itself changes.
 */
export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathNotAllowedError'
  }
}

/**
 * True when target is the root itself or sits beneath it.
 *
 * The separator matters: a bare startsWith would accept "/data/uploads-evil"
 * for the root "/data/uploads".
 */
function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * Resolves a configured root to a real, existing directory.
 *
 * Messages describe the problem without echoing the path: a misconfigured root
 * is an operator's problem, and a caller has no need to learn where the fence
 * sits.
 */
async function resolveRoot(rootVar: string, env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env[rootVar]
  if (!configured) {
    throw new RootNotConfiguredError(
      `Disabled: set ${rootVar} to the directory this operation may use`,
    )
  }

  try {
    const root = await realpath(configured)
    if (!(await stat(root)).isDirectory()) {
      throw new RootNotConfiguredError(`${rootVar} is set but does not point at a directory`)
    }
    return root
  } catch (error) {
    if (error instanceof RootNotConfiguredError) {
      throw error
    }
    throw new RootNotConfiguredError(`${rootVar} is set but the directory could not be read`)
  }
}

/**
 * Resolves a caller-supplied path to an EXISTING file inside the root.
 *
 * Both root and candidate go through realpath BEFORE being compared, so a
 * symlink planted inside the root cannot point outside it. Comparing unresolved
 * strings is the classic hole in this check.
 *
 * @param candidate - Path from the caller. Relative paths resolve against the root.
 * @param env - Defaulted per CLAUDE.md > Established conventions.
 * @throws PathNotAllowedError naming the candidate, never the root.
 */
export async function resolveExistingFile(
  candidate: string,
  rootVar: string = UPLOAD_ROOT_VAR,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = await resolveRoot(rootVar, env)
  const requested = isAbsolute(candidate) ? candidate : resolve(root, candidate)

  // Cheap check first, so a plainly-outside path is refused before the
  // filesystem is touched and before its existence can be probed.
  if (!isContained(root, resolve(requested))) {
    throw new PathNotAllowedError(`Path is outside the permitted directory: ${candidate}`)
  }

  let real: string
  try {
    real = await realpath(requested)
  } catch {
    throw new PathNotAllowedError(`No such file: ${candidate}`)
  }

  // Re-checked after realpath: the first check saw the symlink, this one sees
  // where it actually points.
  if (!isContained(root, real)) {
    throw new PathNotAllowedError(`Path is outside the permitted directory: ${candidate}`)
  }

  if (!(await stat(real)).isFile()) {
    throw new PathNotAllowedError(`Not a regular file: ${candidate}`)
  }

  return real
}

/**
 * Resolves a caller-supplied path to a file that may not exist yet, inside the
 * root. Used by writes, where the target is about to be created.
 *
 * The target cannot be realpath'd (it may not exist), so its PARENT is resolved
 * instead and must already exist. Skipping the parent check would let
 * "<root>/../evil.txt" through, and a symlinked parent pointing outside the
 * root is exactly the escape the read side already guards against.
 *
 * @param candidate - Path from the caller. Relative paths resolve against the root.
 * @param env - Defaulted per CLAUDE.md > Established conventions.
 * @throws PathNotAllowedError naming the candidate, never the root.
 */
export async function resolveNewFilePath(
  candidate: string,
  rootVar: string = DOWNLOAD_ROOT_VAR,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = await resolveRoot(rootVar, env)
  const requested = isAbsolute(candidate) ? candidate : resolve(root, candidate)

  const name = basename(requested)
  if (!name || name === '.' || name === '..') {
    throw new PathNotAllowedError(`Not a usable file name: ${candidate}`)
  }

  let realParent: string
  try {
    realParent = await realpath(dirname(requested))
  } catch {
    throw new PathNotAllowedError(`Parent directory does not exist: ${candidate}`)
  }

  const target = join(realParent, name)
  if (!isContained(root, target)) {
    throw new PathNotAllowedError(`Path is outside the permitted directory: ${candidate}`)
  }

  // An existing directory at the target is not something a write can replace.
  try {
    if ((await stat(target)).isDirectory()) {
      throw new PathNotAllowedError(`Path is a directory: ${candidate}`)
    }
  } catch (error) {
    if (error instanceof PathNotAllowedError) {
      throw error
    }
    // Not existing yet is the normal case for a write target.
  }

  return target
}
