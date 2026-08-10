import { basename } from 'node:path'
import { writeStreamAtomically } from '../atomic-write.js'
import { appendAuditRecord, auditLogPath, type AuditRecord } from '../audit-log.js'
import { ARCHIVE_ROOT_VAR, resolveNewFilePath } from '../path-fence.js'
import { BucketNotFoundError } from './files.js'

/** What hiding produced. The data survives in version history. */
export interface HideReceipt {
  readonly bucketName: string
  readonly fileName: string
  readonly hideMarkerFileId: string
  readonly hiddenAt: string
}

/** What unhiding produced. restored is false when nothing was hidden. */
export interface UnhideReceipt {
  readonly bucketName: string
  readonly fileName: string
  readonly removedMarkerFileId: string | null
  readonly restored: boolean
}

/**
 * What a deletion recorded.
 *
 * IMPORTANT: deleteVersion returns nothing, so this is built from metadata read
 * BEFORE the delete plus the caller's own inputs. It is a record of what was
 * requested and not rejected, NOT independent confirmation from B2 that the
 * version is gone.
 */
export interface DeleteReceipt {
  readonly bucketName: string
  readonly fileName: string
  readonly fileId: string
  readonly contentLength: number
  readonly contentSha1: string | null
  readonly archivedTo: string | null
  readonly deletedAt: string
}

/** The version metadata this module reads off the SDK. */
export interface FileVersionMeta {
  readonly fileId: string
  readonly fileName: string
  readonly contentLength: number
  readonly contentType: string
  readonly contentSha1: string | null
  readonly uploadTimestamp: number
}

/** The subset of a B2Object handle this module needs. */
export interface FileHandle {
  getFileInfo(fileId: string): Promise<FileVersionMeta>
  downloadById(fileId: string): Promise<{
    readonly headers: { readonly contentLength: number }
    readonly body: ReadableStream<Uint8Array>
  }>
  deleteVersion(fileId: string): Promise<void>
  hide(): Promise<FileVersionMeta>
}

/** The subset of a Bucket handle this module needs. */
export interface MutableBucket {
  file(fileName: string): FileHandle
  unhideFile(fileName: string): Promise<FileVersionMeta | null>
}

/** The subset of B2Client this module needs. */
export interface BucketMutator {
  getBucket(bucketName: string): Promise<MutableBucket | null>
}

/** Resolves a bucket or says plainly that it is not there. */
async function requireBucket(
  client: BucketMutator,
  bucketName: string,
): Promise<MutableBucket> {
  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    throw new BucketNotFoundError(bucketName)
  }
  return bucket
}

/** Writes a record, ignoring the absence of a log for reversible actions. */
async function recordIfConfigured(
  record: AuditRecord,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!env.B2_AUDIT_LOG) {
    return
  }
  await appendAuditRecord(record, env)
}

/**
 * Hides a file so it stops appearing in listings.
 *
 * Reversible: B2 keeps the data in version history and unhideFile brings it
 * back, which is why this is not gated on an audit log the way deletion is.
 * Change this if hiding ever stops being recoverable.
 */
export async function hideFile(
  client: BucketMutator,
  options: { bucketName: string; fileName: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<HideReceipt> {
  const bucket = await requireBucket(client, options.bucketName)
  const marker = await bucket.file(options.fileName).hide()
  const hiddenAt = new Date().toISOString()

  await recordIfConfigured(
    {
      at: hiddenAt,
      action: 'hide',
      phase: 'outcome',
      bucketName: options.bucketName,
      fileName: options.fileName,
      fileId: marker.fileId,
      outcome: 'hidden',
    },
    env,
  )

  return {
    bucketName: options.bucketName,
    fileName: options.fileName,
    hideMarkerFileId: marker.fileId,
    hiddenAt,
  }
}

/**
 * Removes the latest hide marker, making a file visible again.
 *
 * Nothing hidden is NOT an error: restored is false and the marker id is null.
 * Turning a no-op into a failure would make an idempotent operation look broken
 * on a second call.
 */
export async function unhideFile(
  client: BucketMutator,
  options: { bucketName: string; fileName: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<UnhideReceipt> {
  const bucket = await requireBucket(client, options.bucketName)
  const marker = await bucket.unhideFile(options.fileName)

  await recordIfConfigured(
    {
      at: new Date().toISOString(),
      action: 'unhide',
      phase: 'outcome',
      bucketName: options.bucketName,
      fileName: options.fileName,
      ...(marker ? { fileId: marker.fileId } : {}),
      outcome: 'unhidden',
    },
    env,
  )

  return {
    bucketName: options.bucketName,
    fileName: options.fileName,
    removedMarkerFileId: marker?.fileId ?? null,
    restored: marker !== null,
  }
}

/**
 * Permanently destroys one version of a file. B2 cannot undo this.
 *
 * The caller must supply the exact fileId; this function never resolves one
 * from a file name. That is the safety mechanism: an id has to come from
 * b2_list_files, where a human can see which version is at stake, so a vague or
 * injected instruction cannot cascade into destruction nobody reviewed.
 *
 * Order matters and is not arbitrary:
 *   1. audit log configured, or nothing happens at all
 *   2. read metadata -- after deletion it exists nowhere
 *   3. archive if configured -- non-destructive, so failure aborts safely
 *   4. write the intent record
 *   5. delete
 *   6. write the outcome record, success or failure
 *
 * bypassGovernance is deliberately never sent: an override for a deletion guard
 * does not belong in a tool an LLM can call unprompted.
 *
 * Change this when deletion needs to cover more than a single version.
 */
export async function deleteFileVersion(
  client: BucketMutator,
  options: { bucketName: string; fileName: string; fileId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeleteReceipt> {
  // Throws when unset, before any API call and before anything is destroyed.
  auditLogPath(env)

  const bucket = await requireBucket(client, options.bucketName)
  const handle = bucket.file(options.fileName)

  const meta = await handle.getFileInfo(options.fileId)
  const archivedTo = await archiveVersion(handle, options, meta, env)

  const base = {
    action: 'delete' as const,
    bucketName: options.bucketName,
    fileName: options.fileName,
    fileId: options.fileId,
    contentLength: meta.contentLength,
    contentType: meta.contentType,
    contentSha1: meta.contentSha1,
    uploadTimestamp: meta.uploadTimestamp,
    archivedTo,
  }

  await appendAuditRecord({ ...base, at: new Date().toISOString(), phase: 'intent' }, env)

  try {
    await handle.deleteVersion(options.fileId)
  } catch (error) {
    await appendAuditRecord(
      {
        ...base,
        at: new Date().toISOString(),
        phase: 'outcome',
        outcome: 'failed',
        error: error instanceof Error ? error.message || error.name : String(error),
      },
      env,
    )
    throw error
  }

  const deletedAt = new Date().toISOString()
  await appendAuditRecord({ ...base, at: deletedAt, phase: 'outcome', outcome: 'deleted' }, env)

  return {
    bucketName: options.bucketName,
    fileName: options.fileName,
    fileId: options.fileId,
    contentLength: meta.contentLength,
    contentSha1: meta.contentSha1,
    archivedTo,
    deletedAt,
  }
}

/**
 * Copies the exact version being deleted into the archive, when one is set.
 *
 * Downloads BY ID, never by name: fetching the current version while an older
 * one is deleted would preserve the wrong bytes and still look successful.
 * The destination goes through the path fence because its name derives from the
 * B2 file name, which is caller-controlled data.
 *
 * @returns Where the copy landed, or null when archiving is switched off.
 */
async function archiveVersion(
  handle: FileHandle,
  options: { fileName: string; fileId: string },
  meta: FileVersionMeta,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!env[ARCHIVE_ROOT_VAR]) {
    return null
  }

  // The id is in the name so two versions of one file cannot overwrite one
  // another in the archive -- which would destroy the very thing being kept.
  const target = await resolveNewFilePath(
    `${basename(options.fileName)}.${options.fileId}`,
    ARCHIVE_ROOT_VAR,
    env,
  )

  const { headers, body } = await handle.downloadById(options.fileId)
  await writeStreamAtomically(body, target, headers.contentLength)
  return target
}
