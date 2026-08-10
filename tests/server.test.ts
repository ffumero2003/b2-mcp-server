import { describe, expect, it } from 'vitest'
import { toMessage } from '../src/server.js'

/**
 * Rebuilds what the B2 SDK actually throws, verified against a live 401 from
 * @backblaze-labs/b2-sdk 0.2.0: an Error subclass whose message is EMPTY, with
 * the diagnosis carried on name/code/status instead.
 *
 * This shape is the whole point of the fixture. A plain Error with a populated
 * message -- the original fixture -- passed while the real path returned a
 * blank error to the user.
 */
function b2StyleError(): Error {
  const error = new Error('')
  error.name = 'BadAuthTokenError'
  Object.assign(error, { code: 'bad_auth_token', status: 401 })
  return error
}

describe('toMessage', () => {
  it('never returns an empty string for a B2 error with an empty message', () => {
    // The regression itself: a blank tool error tells the user nothing.
    expect(toMessage(b2StyleError())).not.toBe('')
  })

  it('surfaces the B2 error name, code, and status', () => {
    const message = toMessage(b2StyleError())

    expect(message).toContain('BadAuthTokenError')
    expect(message).toContain('bad_auth_token')
    expect(message).toContain('401')
  })

  it('prefers a real message when the error has one', () => {
    expect(toMessage(new Error('Missing required environment variable'))).toBe(
      'Missing required environment variable',
    )
  })

  it('degrades gracefully when the error carries only a name', () => {
    const bare = new Error('')
    bare.name = 'NetworkError'

    expect(toMessage(bare)).toBe('NetworkError')
  })

  it('stringifies a non-Error throw', () => {
    expect(toMessage('plain string failure')).toBe('plain string failure')
  })
})
