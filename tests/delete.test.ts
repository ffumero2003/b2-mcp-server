import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_LOG_VAR, type AuditRecord } from '../src/audit-log.js'
import {
  deleteFileVersion,
  hideFile,
  unhideFile,
  type BucketMutator,
  type FileVersionMeta,
} from '../src/b2/delete.js'
import { BucketNotFoundError } from '../src/b2/files.js'
import { ARCHIVE_ROOT_VAR } from '../src/path-fence.js'

const BODY = 'archived bytes\n'
const FILE_ID = 'file-id-1'

let dir: string
let logPath: string
let archiveRoot: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  // realpathSync because macOS /var is a symlink to /private/var, and the path
  // fence resolves before returning. Comparing against the unresolved temp path
  // fails on a fence that is behaving exactly as designed.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'b2-delete-')))
  logPath = join(dir, 'audit.jsonl')
  archiveRoot = join(dir, 'archive')
  mkdirSync(archiveRoot)
  env = { [AUDIT_LOG_VAR]: logPath }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function meta(overrides: Partial<FileVersionMeta> = {}): FileVersionMeta {
  return {
    fileId: FILE_ID,
    fileName: 'hello.txt',
    contentLength: Buffer.byteLength(BODY),
    contentType: 'text/plain',
    contentSha1: 'sha1-of-hello',
    uploadTimestamp: Date.UTC(2024, 0, 2),
    ...overrides,
  }
}

function bodyStream(text = BODY): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

interface Spies {
  deleteVersion: ReturnType<typeof vi.fn>
  downloadById: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  unhideFile: ReturnType<typeof vi.fn>
  getFileInfo: ReturnType<typeof vi.fn>
}

/** Stands in for B2Client with no network and no credentials. */
function fakeClient(
  opts: {
    info?: FileVersionMeta
    onDelete?: () => Promise<void>
    onDownload?: () => Promise<{ headers: { contentLength: number }; body: ReadableStream<Uint8Array> }>
    unhideResult?: FileVersionMeta | null
  } = {},
): BucketMutator & { spies: Spies } {
  const info = opts.info ?? meta()
  const spies: Spies = {
    getFileInfo: vi.fn(async () => info),
    deleteVersion: vi.fn(opts.onDelete ?? (async () => undefined)),
    downloadById: vi.fn(
      opts.onDownload ??
        (async () => ({ headers: { contentLength: info.contentLength }, body: bodyStream() })),
    ),
    hide: vi.fn(async () => meta({ fileId: 'hide-marker-1' })),
    unhideFile: vi.fn(async () =>
      opts.unhideResult === undefined ? meta({ fileId: 'hide-marker-1' }) : opts.unhideResult,
    ),
  }

  return {
    spies,
    getBucket: async () => ({
      file: () => ({
        getFileInfo: spies.getFileInfo as never,
        downloadById: spies.downloadById as never,
        deleteVersion: spies.deleteVersion as never,
        hide: spies.hide as never,
      }),
      unhideFile: spies.unhideFile as never,
    }),
  }
}

/** The log as parsed records, proving each line is valid JSON. */
function readRecords(): AuditRecord[] {
  if (!existsSync(logPath)) {
    return []
  }
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRecord)
}

describe('hideFile', () => {
  it('returns the marker id and records the action', async () => {
    const client = fakeClient()
    const receipt = await hideFile(client, { bucketName: 'b', fileName: 'hello.txt' }, env)

    expect(receipt.hideMarkerFileId).toBe('hide-marker-1')
    expect(readRecords()[0]).toMatchObject({ action: 'hide', outcome: 'hidden' })
  })

  it('works with no audit log configured, because hiding is reversible', async () => {
    const client = fakeClient()

    await expect(
      hideFile(client, { bucketName: 'b', fileName: 'hello.txt' }, {}),
    ).resolves.toMatchObject({ hideMarkerFileId: 'hide-marker-1' })
  })

  it('raises BucketNotFoundError for an unknown bucket', async () => {
    const missing: BucketMutator = { getBucket: async () => null }

    await expect(
      hideFile(missing, { bucketName: 'nope', fileName: 'hello.txt' }, env),
    ).rejects.toThrow(BucketNotFoundError)
  })
})

describe('unhideFile', () => {
  it('reports restored with the removed marker id', async () => {
    const client = fakeClient()
    const receipt = await unhideFile(client, { bucketName: 'b', fileName: 'hello.txt' }, env)

    expect(receipt).toMatchObject({ restored: true, removedMarkerFileId: 'hide-marker-1' })
  })

  it('reports restored false without throwing when nothing was hidden', async () => {
    // A no-op must not look like a failure, or a second call appears broken.
    const client = fakeClient({ unhideResult: null })
    const receipt = await unhideFile(client, { bucketName: 'b', fileName: 'hello.txt' }, env)

    expect(receipt).toMatchObject({ restored: false, removedMarkerFileId: null })
  })
})

describe('deleteFileVersion', () => {
  const target = { bucketName: 'b', fileName: 'hello.txt', fileId: FILE_ID }

  it('REFUSES and never calls deleteVersion when no audit log is configured', async () => {
    // The gate: no record, no destruction, and no API call spent finding out.
    const client = fakeClient()

    await expect(deleteFileVersion(client, target, {})).rejects.toThrow(/B2_AUDIT_LOG/)
    expect(client.spies.deleteVersion).not.toHaveBeenCalled()
    expect(client.spies.getFileInfo).not.toHaveBeenCalled()
  })

  it('reads metadata BEFORE deleting and puts the real values in the receipt', async () => {
    const client = fakeClient()
    const receipt = await deleteFileVersion(client, target, env)

    expect(client.spies.getFileInfo).toHaveBeenCalledWith(FILE_ID)
    expect(receipt).toMatchObject({
      contentLength: Buffer.byteLength(BODY),
      contentSha1: 'sha1-of-hello',
      fileId: FILE_ID,
    })
  })

  it('writes an intent record and then an outcome record, in that order', async () => {
    await deleteFileVersion(fakeClient(), target, env)

    const records = readRecords()
    expect(records.map((r) => r.phase)).toEqual(['intent', 'outcome'])
    expect(records[1]).toMatchObject({ outcome: 'deleted', contentSha1: 'sha1-of-hello' })
  })

  it('still leaves an intent record AND a failure outcome when the delete fails', async () => {
    // An audit log that only records successes is not an audit log.
    const client = fakeClient({
      onDelete: async () => {
        throw new Error('file is under legal hold')
      },
    })

    await expect(deleteFileVersion(client, target, env)).rejects.toThrow(/legal hold/)

    const records = readRecords()
    expect(records.map((r) => r.phase)).toEqual(['intent', 'outcome'])
    expect(records[1]).toMatchObject({ outcome: 'failed', error: 'file is under legal hold' })
  })

  it('never sends bypassGovernance', async () => {
    // An override for a deletion guard must not be reachable from a tool call.
    const client = fakeClient()
    await deleteFileVersion(client, target, env)

    expect(client.spies.deleteVersion).toHaveBeenCalledWith(FILE_ID)
    expect(client.spies.deleteVersion.mock.calls[0]).toHaveLength(1)
  })

  it('archives the exact version by id, not the current one by name', async () => {
    // Archiving the current version while deleting an older one would keep the
    // wrong bytes and still look successful.
    const client = fakeClient()
    const receipt = await deleteFileVersion(client, target, {
      ...env,
      [ARCHIVE_ROOT_VAR]: archiveRoot,
    })

    expect(client.spies.downloadById).toHaveBeenCalledWith(FILE_ID)
    expect(receipt.archivedTo).toBe(join(archiveRoot, `hello.txt.${FILE_ID}`))
    expect(readFileSync(receipt.archivedTo!, 'utf8')).toBe(BODY)
  })

  it('names the archive copy with the version id so versions cannot overwrite each other', async () => {
    const client = fakeClient()
    const receipt = await deleteFileVersion(
      client,
      { ...target, fileId: 'other-version' },
      { ...env, [ARCHIVE_ROOT_VAR]: archiveRoot },
    )

    expect(receipt.archivedTo).toBe(join(archiveRoot, 'hello.txt.other-version'))
  })

  it('records archivedTo as null when archiving is switched off', async () => {
    const client = fakeClient()
    const receipt = await deleteFileVersion(client, target, env)

    expect(receipt.archivedTo).toBeNull()
    expect(client.spies.downloadById).not.toHaveBeenCalled()
  })

  it('aborts before deleting when archiving fails', async () => {
    // Archiving is non-destructive, so its failure must cost nothing.
    const client = fakeClient({
      onDownload: async () => {
        throw new Error('network died')
      },
    })

    await expect(
      deleteFileVersion(client, target, { ...env, [ARCHIVE_ROOT_VAR]: archiveRoot }),
    ).rejects.toThrow('network died')
    expect(client.spies.deleteVersion).not.toHaveBeenCalled()
    expect(readRecords()).toEqual([])
  })

  it('raises BucketNotFoundError for an unknown bucket', async () => {
    const missing: BucketMutator = { getBucket: async () => null }

    await expect(
      deleteFileVersion(missing, { ...target, bucketName: 'nope' }, env),
    ).rejects.toThrow(BucketNotFoundError)
  })

  it('propagates a retention rejection unchanged, so the caller sees B2 reason', async () => {
    const client = fakeClient({
      onDelete: async () => {
        throw new Error('compliance mode retention has not expired')
      },
    })

    await expect(deleteFileVersion(client, target, env)).rejects.toThrow(
      'compliance mode retention has not expired',
    )
  })
})
