import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

/** Environment variable naming the only directory uploads may read from. */
export const UPLOAD_ROOT_VAR = 'B2_UPLOAD_ROOT'

/**
 * Raised when no upload root is configured, or the configured one is unusable.
 *
 * Uploads deny by default: a server that reads any path a model names is an
 * exfiltration primitive. Change this only if uploads stop touching the local
 * filesystem.
 */
export class UploadRootNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRootNotConfiguredError'
  }
}

/**
 * Raised when a candidate path is outside the upload root or is not a file.
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
 * Resolves the configured upload root to a real, existing directory.
 *
 * Messages here describe the problem without echoing the path: a root
 * misconfiguration is an operator's problem, and the caller has no need to
 * learn where the fence sits.
 */
async function resolveRoot(env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env[UPLOAD_ROOT_VAR]
  if (!configured) {
    throw new UploadRootNotConfiguredError(
      `Uploads are disabled: set ${UPLOAD_ROOT_VAR} to the directory uploads may read from`,
    )
  }

  try {
    const root = await realpath(configured)
    if (!(await stat(root)).isDirectory()) {
      throw new UploadRootNotConfiguredError(
        `${UPLOAD_ROOT_VAR} is set but does not point at a directory`,
      )
    }
    return root
  } catch (error) {
    if (error instanceof UploadRootNotConfiguredError) {
      throw error
    }
    throw new UploadRootNotConfiguredError(
      `${UPLOAD_ROOT_VAR} is set but the directory could not be read`,
    )
  }
}

/**
 * Resolves a caller-supplied path to a real file inside the upload root.
 *
 * Both the root and the candidate go through realpath BEFORE being compared, so
 * a symlink planted inside the root cannot point outside it. Comparing
 * unresolved strings is the classic hole in this check.
 *
 * Change this when uploads need more than one permitted root.
 *
 * @param candidate - Path from the caller. Relative paths resolve against the root.
 * @param env - Defaulted so tests supply a fake environment (CLAUDE.md >
 * Established conventions, Defaulted-collaborator parameter).
 * @returns The real, symlink-free absolute path, safe to read.
 * @throws UploadRootNotConfiguredError when the root is unset or unusable.
 * @throws PathNotAllowedError when the candidate escapes the root or is not a
 * regular file. The message names the candidate but never the root.
 */
export async function resolveUploadPath(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = await resolveRoot(env)
  const requested = isAbsolute(candidate) ? candidate : resolve(root, candidate)

  // Cheap check first, so a plainly-outside path is refused before the
  // filesystem is touched and before its existence can be probed.
  if (!isContained(root, resolve(requested))) {
    throw new PathNotAllowedError(`Path is outside the permitted upload directory: ${candidate}`)
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
    throw new PathNotAllowedError(`Path is outside the permitted upload directory: ${candidate}`)
  }

  if (!(await stat(real)).isFile()) {
    throw new PathNotAllowedError(`Not a regular file: ${candidate}`)
  }

  return real
}
