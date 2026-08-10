import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIT_LOG_VAR,
  AuditLogNotConfiguredError,
  appendAuditRecord,
  auditLogPath,
  type AuditRecord,
} from '../src/audit-log.js'

let dir: string
let logPath: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b2-audit-'))
  logPath = join(dir, 'b2-audit.jsonl')
  env = { [AUDIT_LOG_VAR]: logPath }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    at: '2026-08-10T22:00:00.000Z',
    action: 'delete',
    phase: 'intent',
    bucketName: 'my-bucket',
    fileName: 'hello.txt',
    fileId: 'file-id-1',
    ...overrides,
  }
}

/** The log as parsed objects, which also proves every line is valid JSON. */
function readRecords(): AuditRecord[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRecord)
}

describe('auditLogPath', () => {
  it('returns the configured path', () => {
    expect(auditLogPath(env)).toBe(logPath)
  })

  it('throws when unset, naming the variable to set', () => {
    expect(() => auditLogPath({})).toThrow(AuditLogNotConfiguredError)
    expect(() => auditLogPath({})).toThrow(/B2_AUDIT_LOG/)
  })
})

describe('appendAuditRecord', () => {
  it('writes one record as a single line of valid JSON', async () => {
    await appendAuditRecord(record(), env)

    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(readRecords()[0]).toMatchObject({ action: 'delete', fileName: 'hello.txt' })
  })

  it('appends without disturbing earlier records', async () => {
    await appendAuditRecord(record({ phase: 'intent' }), env)
    await appendAuditRecord(record({ phase: 'outcome', outcome: 'deleted' }), env)

    const records = readRecords()
    expect(records).toHaveLength(2)
    expect(records[0]!.phase).toBe('intent')
    expect(records[1]!.phase).toBe('outcome')
  })

  it('preserves content that was already in the file', async () => {
    // Append-only: an existing log must never be rewritten or truncated.
    writeFileSync(logPath, '{"pre":"existing"}\n')
    await appendAuditRecord(record(), env)

    const raw = readFileSync(logPath, 'utf8')
    expect(raw.startsWith('{"pre":"existing"}\n')).toBe(true)
    expect(raw.trimEnd().split('\n')).toHaveLength(2)
  })

  it('keeps a field containing a newline on one line', async () => {
    // Otherwise a crafted file name could forge an extra log record.
    await appendAuditRecord(record({ fileName: 'evil\n{"forged":true}' }), env)

    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(readRecords()[0]!.fileName).toBe('evil\n{"forged":true}')
  })

  it('refuses when no log is configured', async () => {
    await expect(appendAuditRecord(record(), {})).rejects.toThrow(AuditLogNotConfiguredError)
  })

  it('refuses a path whose parent directory does not exist, rather than creating it', async () => {
    const missing = join(dir, 'nope', 'audit.jsonl')

    await expect(
      appendAuditRecord(record(), { [AUDIT_LOG_VAR]: missing }),
    ).rejects.toThrow(AuditLogNotConfiguredError)
  })
})
