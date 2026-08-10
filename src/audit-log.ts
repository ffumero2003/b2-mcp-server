import { appendFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Environment variable naming the append-only log of destructive actions. */
export const AUDIT_LOG_VAR = 'B2_AUDIT_LOG'

/** What happened, or was about to. */
export type AuditAction = 'hide' | 'unhide' | 'delete'

/**
 * Whether this line records an attempt or its result.
 *
 * Both are written for a delete, in that order. An audit log that can miss
 * events is not an audit log: a crash between the API call and the outcome line
 * leaves an intent with no outcome, which honestly reads as "we do not know"
 * rather than silently omitting a real deletion.
 */
export type AuditPhase = 'intent' | 'outcome'

/** One line of the log. Optional fields are absent when they do not apply. */
export interface AuditRecord {
  readonly at: string
  readonly action: AuditAction
  readonly phase: AuditPhase
  readonly bucketName: string
  readonly fileName: string
  readonly fileId?: string
  readonly contentLength?: number
  readonly contentType?: string
  readonly contentSha1?: string | null
  readonly uploadTimestamp?: number
  readonly archivedTo?: string | null
  readonly outcome?: 'deleted' | 'hidden' | 'unhidden' | 'failed'
  readonly error?: string
}

/**
 * Raised when no audit log is configured. Deletion is refused in that state.
 * Change this only if destroying data stops requiring a record.
 */
export class AuditLogNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditLogNotConfiguredError'
  }
}

/**
 * The configured log path.
 *
 * NOT passed through src/path-fence.ts, deliberately: the fence contains
 * CALLER-supplied paths, and this one comes from the operator's own
 * environment, the same trust level as the credentials. Fencing it would imply
 * the operator is the threat and would stop the log living outside a data
 * directory.
 *
 * @param env - Defaulted per CLAUDE.md > Established conventions.
 * @throws AuditLogNotConfiguredError when unset.
 */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AUDIT_LOG_VAR]
  if (!configured) {
    throw new AuditLogNotConfiguredError(
      `Refusing to destroy data with no record: set ${AUDIT_LOG_VAR} to a file path`,
    )
  }
  return configured
}

/**
 * Appends one record as a single line of JSON.
 *
 * JSON Lines because appending never rewrites: a corrupted or partial line can
 * never destroy earlier records, and the file greps and tails without a parser.
 * JSON.stringify escapes newlines, so a field containing one still occupies
 * exactly one line and cannot forge a second record.
 *
 * Change this if the log needs rotation or a different sink.
 *
 * @throws AuditLogNotConfiguredError when unset, or when the parent directory
 * does not exist -- a typo in the path should fail loudly rather than scatter
 * logs into directories nobody meant to create.
 */
export async function appendAuditRecord(
  record: AuditRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = auditLogPath(env)

  const parent = dirname(path)
  try {
    if (!(await stat(parent)).isDirectory()) {
      throw new AuditLogNotConfiguredError(`${AUDIT_LOG_VAR} parent is not a directory`)
    }
  } catch (error) {
    if (error instanceof AuditLogNotConfiguredError) {
      throw error
    }
    throw new AuditLogNotConfiguredError(
      `${AUDIT_LOG_VAR} points into a directory that does not exist`,
    )
  }

  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}
