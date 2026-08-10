import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PathNotAllowedError,
  UPLOAD_ROOT_VAR,
  UploadRootNotConfiguredError,
  resolveUploadPath,
} from '../src/upload-path.js'

let root: string
let outside: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  // realpathSync because macOS /var is itself a symlink to /private/var; without
  // it every containment comparison in these tests would be against a path the
  // implementation never sees.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'b2-upload-root-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'b2-outside-')))
  env = { [UPLOAD_ROOT_VAR]: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('resolveUploadPath', () => {
  it('accepts a file directly inside the root', async () => {
    writeFileSync(join(root, 'ok.txt'), 'x')

    await expect(resolveUploadPath(join(root, 'ok.txt'), env)).resolves.toBe(
      join(root, 'ok.txt'),
    )
  })

  it('accepts a file in a nested subdirectory', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'deep.txt'), 'x')

    await expect(resolveUploadPath(join(root, 'a', 'b', 'deep.txt'), env)).resolves.toBe(
      join(root, 'a', 'b', 'deep.txt'),
    )
  })

  it('resolves a relative path against the root', async () => {
    writeFileSync(join(root, 'rel.txt'), 'x')

    await expect(resolveUploadPath('rel.txt', env)).resolves.toBe(join(root, 'rel.txt'))
  })

  it('rejects a traversal escape with ..', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'x')

    await expect(
      resolveUploadPath(join(root, '..', 'nope', 'secret.txt'), env),
    ).rejects.toThrow(PathNotAllowedError)
  })

  it('rejects an absolute path outside the root', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'x')

    await expect(resolveUploadPath(join(outside, 'secret.txt'), env)).rejects.toThrow(
      PathNotAllowedError,
    )
  })

  it('rejects a sibling directory whose name merely starts with the root', async () => {
    // The bare-startsWith bug: "<root>-evil" must not pass for root "<root>".
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'secret.txt'), 'x')

    try {
      await expect(resolveUploadPath(join(sibling, 'secret.txt'), env)).rejects.toThrow(
        PathNotAllowedError,
      )
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('rejects a symlink inside the root that points outside it', async () => {
    // The reason both root and candidate go through realpath before comparing.
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'innocent.txt'))

    await expect(resolveUploadPath(join(root, 'innocent.txt'), env)).rejects.toThrow(
      PathNotAllowedError,
    )
  })

  it('rejects a directory', async () => {
    mkdirSync(join(root, 'adir'))

    await expect(resolveUploadPath(join(root, 'adir'), env)).rejects.toThrow(
      /Not a regular file/,
    )
  })

  it('rejects a path that does not exist', async () => {
    await expect(resolveUploadPath(join(root, 'ghost.txt'), env)).rejects.toThrow(
      /No such file/,
    )
  })

  it('refuses everything when the root is not configured', async () => {
    await expect(resolveUploadPath('anything.txt', {})).rejects.toThrow(
      UploadRootNotConfiguredError,
    )
  })

  it('reports an unusable root without echoing the configured path', async () => {
    const secretish = join(outside, 'does-not-exist-root')

    try {
      await resolveUploadPath('x.txt', { [UPLOAD_ROOT_VAR]: secretish })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(UploadRootNotConfiguredError)
      expect((error as Error).message).not.toContain(secretish)
    }
  })

  it('never names the root in a rejection message', async () => {
    // Telling a caller where the fence is helps only the caller trying to climb it.
    writeFileSync(join(outside, 'secret.txt'), 'x')

    try {
      await resolveUploadPath(join(outside, 'secret.txt'), env)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain(root)
    }
  })
})
