import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDotEnv } from '../src/env-file.js'

const ID_VAR = 'B2_APPLICATION_KEY_ID'
const KEY_VAR = 'B2_APPLICATION_KEY'

let root: string
let saved: Record<string, string | undefined>

/** Writes a .env into the temp root. Values here are fixtures, never real keys. */
function writeEnv(contents: string): void {
  writeFileSync(join(root, '.env'), contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'b2-mcp-env-'))
  // process.env is global; snapshot the keys under test so one case cannot
  // leak a value into the next.
  saved = { [ID_VAR]: process.env[ID_VAR], [KEY_VAR]: process.env[KEY_VAR] }
  delete process.env[ID_VAR]
  delete process.env[KEY_VAR]
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('loadDotEnv', () => {
  it('loads both variables from a .env in the given root', () => {
    writeEnv(`${ID_VAR}=fixture-id\n${KEY_VAR}=fixture-secret\n`)

    expect(loadDotEnv(root)).toBe('loaded')
    expect(process.env[ID_VAR]).toBe('fixture-id')
    expect(process.env[KEY_VAR]).toBe('fixture-secret')
  })

  it('reports absent without throwing when there is no .env', () => {
    expect(loadDotEnv(root)).toBe('absent')
    expect(process.env[ID_VAR]).toBeUndefined()
  })

  it('does not overwrite a variable already set in the real environment', () => {
    // The precedence that lets an MCP client's env block win over the file.
    process.env[ID_VAR] = 'from-environment'
    writeEnv(`${ID_VAR}=from-file\n${KEY_VAR}=fixture-secret\n`)

    expect(loadDotEnv(root)).toBe('loaded')
    expect(process.env[ID_VAR]).toBe('from-environment')
    expect(process.env[KEY_VAR]).toBe('fixture-secret')
  })

  it('rethrows a non-ENOENT failure instead of reporting absent', () => {
    // An unreadable .env is a real problem; reporting 'absent' would hide it
    // behind the confusing "missing variable" error further downstream.
    writeEnv(`${ID_VAR}=fixture-id\n`)
    chmodSync(join(root, '.env'), 0o000)

    expect(() => loadDotEnv(root)).toThrow()
  })
})
