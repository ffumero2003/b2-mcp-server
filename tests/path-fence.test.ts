import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PathNotAllowedError,
  RootNotConfiguredError,
  resolveExistingFile,
  resolveNewFilePath,
} from '../src/path-fence.js'

const ROOT_VAR = 'TEST_ROOT'

let root: string
let outside: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  // realpathSync because macOS /var is itself a symlink to /private/var; without
  // it every containment comparison here would be against a path the
  // implementation never sees.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'b2-fence-root-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'b2-fence-out-')))
  env = { [ROOT_VAR]: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('resolveExistingFile', () => {
  it('accepts a file directly inside the root', async () => {
    writeFileSync(join(root, 'ok.txt'), 'x')

    await expect(resolveExistingFile(join(root, 'ok.txt'), ROOT_VAR, env)).resolves.toBe(
      join(root, 'ok.txt'),
    )
  })

  it('accepts a file in a nested subdirectory', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'deep.txt'), 'x')

    await expect(
      resolveExistingFile(join(root, 'a', 'b', 'deep.txt'), ROOT_VAR, env),
    ).resolves.toBe(join(root, 'a', 'b', 'deep.txt'))
  })

  it('resolves a relative path against the root', async () => {
    writeFileSync(join(root, 'rel.txt'), 'x')

    await expect(resolveExistingFile('rel.txt', ROOT_VAR, env)).resolves.toBe(
      join(root, 'rel.txt'),
    )
  })

  it('rejects a traversal escape with ..', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'x')

    await expect(
      resolveExistingFile(join(root, '..', 'nope', 'secret.txt'), ROOT_VAR, env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects an absolute path outside the root', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'x')

    await expect(
      resolveExistingFile(join(outside, 'secret.txt'), ROOT_VAR, env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects a sibling directory whose name merely starts with the root', async () => {
    // The bare-startsWith bug: "<root>-evil" must not pass for root "<root>".
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'secret.txt'), 'x')

    try {
      await expect(
        resolveExistingFile(join(sibling, 'secret.txt'), ROOT_VAR, env),
      ).rejects.toThrow(PathNotAllowedError)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('rejects a symlink inside the root that points outside it', async () => {
    // The reason both root and candidate go through realpath before comparing.
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'innocent.txt'))

    await expect(
      resolveExistingFile(join(root, 'innocent.txt'), ROOT_VAR, env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects a directory', async () => {
    mkdirSync(join(root, 'adir'))

    await expect(resolveExistingFile(join(root, 'adir'), ROOT_VAR, env)).rejects.toThrow(
      /Not a regular file/,
    )
  })

  it('rejects a path that does not exist', async () => {
    await expect(resolveExistingFile(join(root, 'ghost.txt'), ROOT_VAR, env)).rejects.toThrow(
      /No such file/,
    )
  })

  it('refuses everything when the root is not configured', async () => {
    await expect(resolveExistingFile('anything.txt', ROOT_VAR, {})).rejects.toThrow(
      RootNotConfiguredError,
    )
  })

  it('reports an unusable root without echoing the configured path', async () => {
    const secretish = join(outside, 'does-not-exist-root')

    try {
      await resolveExistingFile('x.txt', ROOT_VAR, { [ROOT_VAR]: secretish })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RootNotConfiguredError)
      expect((error as Error).message).not.toContain(secretish)
    }
  })

  it('never names the root in a rejection message', async () => {
    // Telling a caller where the fence is helps only the caller trying to climb it.
    writeFileSync(join(outside, 'secret.txt'), 'x')

    try {
      await resolveExistingFile(join(outside, 'secret.txt'), ROOT_VAR, env)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain(root)
    }
  })
})

describe('resolveNewFilePath', () => {
  it('accepts a target that does not exist yet', async () => {
    await expect(resolveNewFilePath(join(root, 'new.txt'), ROOT_VAR, env)).resolves.toBe(
      join(root, 'new.txt'),
    )
  })

  it('accepts an existing file, leaving the overwrite decision to the caller', async () => {
    writeFileSync(join(root, 'there.txt'), 'x')

    await expect(resolveNewFilePath('there.txt', ROOT_VAR, env)).resolves.toBe(
      join(root, 'there.txt'),
    )
  })

  it('rejects a target whose parent directory does not exist', async () => {
    await expect(
      resolveNewFilePath(join(root, 'nope', 'new.txt'), ROOT_VAR, env),
    ).rejects.toThrow(/Parent directory does not exist/)
  })

  it('rejects a traversal escape even though the target does not exist', async () => {
    // The reason the PARENT is realpath'd: the target itself cannot be.
    await expect(
      resolveNewFilePath(join(root, '..', 'evil.txt'), ROOT_VAR, env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects a target whose parent is a symlink pointing outside the root', async () => {
    symlinkSync(outside, join(root, 'escape'))

    await expect(
      resolveNewFilePath(join(root, 'escape', 'new.txt'), ROOT_VAR, env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects writing onto an existing directory', async () => {
    mkdirSync(join(root, 'adir'))

    await expect(resolveNewFilePath(join(root, 'adir'), ROOT_VAR, env)).rejects.toThrow(
      /is a directory/,
    )
  })

  it('refuses when the root is not configured', async () => {
    await expect(resolveNewFilePath('new.txt', ROOT_VAR, {})).rejects.toThrow(
      RootNotConfiguredError,
    )
  })

  it('never names the root in a rejection message', async () => {
    try {
      await resolveNewFilePath(join(outside, 'evil.txt'), ROOT_VAR, env)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain(root)
    }
  })
})
