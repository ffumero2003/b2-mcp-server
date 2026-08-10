import { open, rename, rm } from 'node:fs/promises'

/** Raised when fewer bytes arrived than the source said to expect. */
export class IncompleteWriteError extends Error {
  constructor(expected: number, actual: number) {
    super(`Incomplete transfer: expected ${expected} bytes, wrote ${actual}`)
    this.name = 'IncompleteWriteError'
  }
}

/**
 * Streams a body to a file, returning how many bytes landed.
 *
 * Counting here rather than trusting the stream is what makes the length check
 * meaningful.
 */
async function writeBodyToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<number> {
  const handle = await open(path, 'w')
  let written = 0
  try {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        await handle.write(value)
        written += value.byteLength
      }
    }
  } finally {
    await handle.close()
  }
  return written
}

/**
 * Writes a stream to a path so the target is either absent or complete, never
 * half-written.
 *
 * The B2 SDK documents that a failed checksum errors the stream AFTER bytes
 * have flowed, so writing straight to the target would leave a truncated file
 * at exactly the path the caller now trusts. Bytes go to a temp file beside the
 * target, get counted, and are renamed onto it only when the count matches.
 * Same directory, so the rename is an atomic move rather than a copy. Any
 * failure removes the temp file and leaves the target untouched.
 *
 * Extracted from downloadFile in plan 005 when archiving needed identical
 * behaviour; two copies of this drift until one of them stops cleaning up.
 * Change this if a caller ever needs a partial file kept for resume.
 *
 * @returns Bytes written, always equal to expectedLength on success.
 * @throws IncompleteWriteError when the body was short.
 */
export async function writeStreamAtomically(
  body: ReadableStream<Uint8Array>,
  target: string,
  expectedLength: number,
): Promise<number> {
  const temp = `${target}.${process.pid}.partial`

  try {
    const written = await writeBodyToFile(body, temp)
    if (written !== expectedLength) {
      throw new IncompleteWriteError(expectedLength, written)
    }
    await rename(temp, target)
    return written
  } catch (error) {
    // Never leave a partial file for the caller to mistake for the real one.
    await rm(temp, { force: true })
    throw error
  }
}
