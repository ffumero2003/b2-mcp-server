import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

const ID_VALUE = 'test-key-id-value'
const KEY_VALUE = 'test-secret-key-value'

describe('loadConfig', () => {
  it('returns both credentials unchanged when present', () => {
    const config = loadConfig({
      B2_APPLICATION_KEY_ID: ID_VALUE,
      B2_APPLICATION_KEY: KEY_VALUE,
    })

    expect(config).toEqual({
      applicationKeyId: ID_VALUE,
      applicationKey: KEY_VALUE,
    })
  })

  it('throws naming B2_APPLICATION_KEY_ID when only that is missing', () => {
    expect(() => loadConfig({ B2_APPLICATION_KEY: KEY_VALUE })).toThrow(ConfigError)
    expect(() => loadConfig({ B2_APPLICATION_KEY: KEY_VALUE })).toThrow(
      /B2_APPLICATION_KEY_ID/,
    )
  })

  it('throws naming B2_APPLICATION_KEY when only that is missing', () => {
    expect(() => loadConfig({ B2_APPLICATION_KEY_ID: ID_VALUE })).toThrow(ConfigError)
    expect(() => loadConfig({ B2_APPLICATION_KEY_ID: ID_VALUE })).toThrow(
      /B2_APPLICATION_KEY\b/,
    )
  })

  it('throws when both are missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
  })

  it('treats an empty string as missing', () => {
    expect(() =>
      loadConfig({ B2_APPLICATION_KEY_ID: '', B2_APPLICATION_KEY: KEY_VALUE }),
    ).toThrow(ConfigError)
    expect(() =>
      loadConfig({ B2_APPLICATION_KEY_ID: ID_VALUE, B2_APPLICATION_KEY: '' }),
    ).toThrow(ConfigError)
  })

  it('never leaks a credential value in the error message', () => {
    // The present credential must not appear in the message raised about the
    // absent one, since tool errors are surfaced to the MCP client.
    try {
      loadConfig({ B2_APPLICATION_KEY: KEY_VALUE })
      expect.unreachable('loadConfig should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain(KEY_VALUE)
      expect(message).not.toContain(ID_VALUE)
    }
  })
})
