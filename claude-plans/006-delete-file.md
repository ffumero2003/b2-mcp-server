# Plan 006 — hide, unhide, and delete a file version, with an audit trail

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"006 - b2_delete_file: delete a file version, and separately hide a file. Wraps
Bucket.deleteFileVersion and Bucket.hideFile. The hide-vs-delete distinction is
the whole design question: hide is reversible, delete is not."

Every tool so far can be undone. Uploading adds a version, downloading writes
into a fenced directory, listing changes nothing. This slice ships the first
action that destroys data B2 cannot give back.

**Scope grew beyond the roadmap line, with the user's approval.** The roadmap
listed hide and delete. This slice also ships unhide, a mandatory audit log, and
optional archiving. The reasoning is in Decisions below; ROADMAP.md's 006 line
is rewritten to match as a Follow-up.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do:

- `Bucket.file(fileName)` returns a `B2Object` carrying everything this slice
  needs, so the work happens through one handle rather than a mix of Bucket and
  raw calls.
- `B2Object.getFileInfo(fileId): Promise<FileVersion>` — metadata for an EXACT
  version. This is what makes a manifest possible; after deletion it answers
  nothing.
- `B2Object.downloadById(fileId, options?): Promise<DownloadResult>` — streams
  an EXACT version. Critical: archiving with `Bucket.download(fileName)` would
  fetch the CURRENT version while an OLDER one is being deleted, preserving the
  wrong bytes and looking successful.
- `B2Object.deleteVersion(fileId): Promise<void>` returns NOTHING.
- `B2Object.hide(): Promise<FileVersion>` creates a hide marker; the file
  "remains in version history but is no longer visible in listFileNames".
- `Bucket.unhideFile(fileName): Promise<FileVersion | null>` returns null when
  there was nothing hidden.
- Object Lock, quoted: compliance-mode files "cannot be deleted until the
  retention expires"; governance-mode needs `bypassGovernance: true` AND a key
  with that capability; legal-hold files "cannot be deleted by anyone".

**Decisions (confirmed with the user):**

- Three separate tools, not one tool with a mode argument.
- Deleting REQUIRES an explicit fileId. This server never resolves one from a
  file name.
- A manifest is MANDATORY for deletion: no audit log configured, no deletion.
- Archiving is OPTIONAL, enabled by configuring an archive root.
- `bypassGovernance` is not exposed at all.
- Unhide ships here, because hide's reversibility is not real unless something
  can reverse it.

## Dependencies

None — reuses the existing stack.

## Goal of this feature

An AI client can hide a file reversibly, restore it, and permanently destroy a
named version — leaving an append-only record of every mutation, and optionally
a byte-for-byte copy of anything destroyed. It deliberately does NOT delete
buckets, delete all versions of a file, bulk delete by prefix, or touch Object
Lock.

## Design

### The safety argument, which drives everything below

`deleteVersion` needs a fileId, and this tool will not resolve one from a file
name. A caller must first run `b2_list_files`, see the versions, and name one.
"Delete hello.txt" cannot be satisfied in a single step, so a vague or injected
instruction cannot cascade into destruction the user never saw.

A `confirm: true` parameter was considered and rejected: the same model that
decides to call the tool would set it, so it stops nothing and only looks like a
guard. The fileId requirement is real friction because the id must come from
somewhere a human can see. MCP's `destructiveHint` is what actually asks a
person, and the client owns that prompt.

**A manifest is not a backup.** It records that a file existed, its SHA-1, size,
and when it was destroyed. It cannot bring bytes back. Archiving is what
preserves bytes. Both ship, and the plan keeps them clearly separate so nobody
later mistakes proof for recovery.

### src/audit-log.ts (new)

    AUDIT_LOG_VAR = 'B2_AUDIT_LOG'
    AuditRecord = { at, action, phase, bucketName, fileName, fileId?,
                    contentLength?, contentType?, contentSha1?,
                    uploadTimestamp?, archivedTo?, outcome?, error? }

    appendAuditRecord(record, env = process.env): Promise<void>
    auditLogPath(env = process.env): string        // throws when unset

- Append-only JSONL: one JSON object per line. Appending never rewrites, so a
  corrupted or partial line can never destroy earlier records, and the file
  greps and tails without a parser.
- **The audit log path does NOT go through src/path-fence.ts, deliberately.**
  The fence exists to contain CALLER-supplied paths. This path comes from the
  operator's own environment, the same trust level as the credentials. Fencing
  it would imply the operator is the threat, and would stop you putting the log
  somewhere sensible outside a data directory. Stated here because a reviewer
  should not have to guess why one path is fenced and another is not.
- Uses **Defaulted-collaborator parameter** (CLAUDE.md > Established
  conventions) for `env`.
- The parent directory must already exist; a missing one raises rather than
  being created, so a typo in the path fails loudly instead of scattering logs.

### src/atomic-write.ts (new — extracted from src/b2/download.ts)

    writeStreamAtomically(body, target, expectedLength): Promise<number>

Plan 005 built temp-file-then-rename inside `downloadFile`. Archiving needs the
identical behaviour, and duplicating it is how two copies drift until one stops
cleaning up. Extracted verbatim: stream to `<target>.<pid>.partial`, count
bytes, verify against expectedLength, rename on success, remove the temp file on
any failure.

`src/b2/download.ts` is rewired to call it and otherwise unchanged. No new test
file: `tests/download.test.ts` already exercises this through `downloadFile`,
including mid-stream failure, short body, and no-.partial-left. Testing the
helper again directly would restate coverage that already exists.

### src/b2/delete.ts (new)

    HideReceipt   = { bucketName, fileName, hideMarkerFileId, hiddenAt }
    UnhideReceipt = { bucketName, fileName, removedMarkerFileId, restored }
    DeleteReceipt = { bucketName, fileName, fileId, contentLength, contentSha1,
                      archivedTo, deletedAt }

    hideFile(client, { bucketName, fileName })
    unhideFile(client, { bucketName, fileName })
    deleteFileVersion(client, { bucketName, fileName, fileId })

- **Structural parameter types at module seams** and **Summary types at the MCP
  boundary** (Established conventions). Reuses `BucketNotFoundError` from
  `src/b2/files.ts`.
- Delete sequence, in this order for reasons that matter:
  1. Resolve the audit log path. **Unconfigured, nothing else happens** — the
     refusal costs no API call and destroys nothing.
  2. `getFileInfo(fileId)` to capture metadata. Must be first among the API
     calls: after deletion this information does not exist anywhere.
  3. If an archive root is configured, `downloadById(fileId)` and write it into
     the archive through `writeStreamAtomically`. Non-destructive, so a failure
     here aborts before anything is lost.
  4. Append the INTENT record.
  5. `deleteVersion(fileId)`.
  6. Append the OUTCOME record — `deleted`, or `failed` with B2's reason.
- **Intent before, outcome after**, because an audit log that can miss events is
  not an audit log. A crash between 5 and 6 leaves an intent with no outcome,
  which honestly reads as "we do not know" rather than silently omitting a real
  deletion. Recording something that then failed is the safer error.
- The archive target goes through `resolveNewFilePath` with `ARCHIVE_ROOT_VAR`,
  because its name derives from the B2 file name, which is caller-controlled
  data. This is the fence doing exactly the job CLAUDE.md > Rules describes.
- **Honest disclosure on DeleteReceipt:** `deleteVersion` returns void, so the
  receipt is built from the pre-delete metadata plus the caller's inputs. It is
  a record of what was requested and not rejected, NOT independent confirmation
  from B2 that the version is gone. The purpose comment says so.
- Hide and unhide log a single record when the audit log is configured, and
  proceed without one when it is not. Only irreversible actions are gated.
- `bypassGovernance` is never sent. A governance-locked file is protected on
  purpose, and a tool an LLM can call is the last place to put an override.
- `unhideFile` returning null is not an error: `restored: false`, null marker id.
  Turning a no-op into a failure would make an idempotent operation look broken.

### src/server.ts (modified)

Three registrations, following **Tool registration shape** (Established
conventions). The annotations differ from each other and the honesty matters:

| tool | readOnly | destructive | idempotent |
|---|---|---|---|
| `b2_hide_file` | false | false — data survives in version history | true |
| `b2_unhide_file` | false | false | true |
| `b2_delete_file_version` | false | **true** | true — deleting a gone version is a no-op |

`b2_delete_file_version` is named for exactly what it does. Calling it
`b2_delete_file` would suggest it removes the file, when it removes ONE version
and may leave older ones. A tool name is the shortest description a model reads.

The delete tool's description states that an audit log is required and that
archiving is optional, so a client can explain a refusal without guessing.

### tests/audit-log.test.ts (new)

Real temp directories via mkdtemp, as `tests/path-fence.test.ts` does.

- a record is appended as one line of valid JSON
- a second record appends without touching the first
- pre-existing content is preserved exactly
- unset B2_AUDIT_LOG raises AuditLogNotConfiguredError
- a path whose parent directory does not exist raises rather than creating it
- a record containing a newline in a field still occupies exactly one line

### tests/delete.test.ts (new)

A fake client shaped from the observed SDK surface, with a temp audit log.

- hide returns the marker id; a record is written
- unhide reports restored true with the removed marker id
- unhide on a visible file reports restored false, no throw
- **delete with no audit log configured refuses, and never calls deleteVersion**
- delete captures metadata BEFORE deleting, and the receipt carries the real
  contentLength and contentSha1
- delete writes an intent record and then an outcome record, in that order
- **a failed delete still leaves an intent record, plus an outcome recording the
  failure**
- delete never sends bypassGovernance
- with an archive root, the archived file's bytes match, and archivedTo appears
  in both the receipt and the record
- **archiving uses the fileId, not the current version**
- an archive failure aborts before deleteVersion is called
- unknown bucket raises BucketNotFoundError
- a retention or legal-hold rejection propagates unchanged, so the caller sees
  B2's own reason

## Files

- src/audit-log.ts — new; appendAuditRecord, auditLogPath, AUDIT_LOG_VAR,
  AuditRecord, AuditLogNotConfiguredError.
- src/atomic-write.ts — new; writeStreamAtomically, extracted from 005.
- src/b2/download.ts — modified; calls the extracted helper.
- src/path-fence.ts — modified; add ARCHIVE_ROOT_VAR.
- src/b2/delete.ts — new; the three functions and three receipts.
- src/server.ts — modified; register the three tools.
- .env.example — modified; document B2_AUDIT_LOG and B2_ARCHIVE_ROOT.
- .gitignore — modified; ignore the default audit log and archive locations.
- tests/audit-log.test.ts — new; the cases above.
- tests/delete.test.ts — new; the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Deleting ALL versions of a file; Bucket.deleteAll and deleteMany.
- Bulk delete by prefix.
- `bypassGovernance`, and any Object Lock manipulation. Deliberate: an override
  for a deletion guard does not belong in a tool an LLM can call unprompted.
- Deleting buckets, and cancelling unfinished large files.
- A tool that READS the audit log back. The file is plain JSONL, greppable
  today; a reader is only worth it if the log gets large.
- Restoring from the archive. The bytes are on disk and can be re-uploaded with
  b2_upload_file, so a dedicated restore tool would be convenience, not
  capability.
- Audit log rotation and size limits.

## Follow-ups after implementation

- Protected files — REQUIRED. Two candidates, assessed once green: the case
  asserting `bypassGovernance` is never sent, and the case asserting a failed
  delete still leaves an intent record. Both are decoys whose removal leaves a
  green suite and a weaker guarantee. If they qualify, appending is pre-approved.
- ROADMAP.md — rewrite the 006 line, which no longer describes what shipped, and
  move it to Done.
- CLAUDE.md Rules — candidate second Rule: a tool that destroys data takes the
  exact identifier of the thing destroyed, never resolves it from a friendlier
  name, and refuses to act unless an append-only record can be written.
- CLAUDE.md Commands — the audit log and archive variables need documenting.
- Established conventions — if 007 repeats the receipt-per-operation module
  shape, harvest it then. Nothing new proposed from this slice alone.
- STATE.md — pre-approved, applied and reported.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can hide a file so it stops appearing in listings, put it back, and
permanently destroy a specific version — and every one of those actions leaves a
line in an append-only log, with a byte-for-byte copy kept when archiving is
switched on. Before this slice nothing the server did could remove anything.

### Steps — confirm it by hand

1. `npm test` — expected: all pass, zero failures. The exact count is confirmed
   against real output; any difference from the case list above is reported, not
   edited to match.
2. `npm run build` — expected: exits 0 silently, dist purged first.
3. Refusal with no audit log — `b2_delete_file_version` with B2_AUDIT_LOG unset:
   expected `isError: true` explaining the log is not configured. Nothing is
   deleted, and this needs no B2 call to prove.
4. Unknown bucket — `b2_hide_file` against a bucket that does not exist:
   expected `isError: true` naming the bucket.
5. Full lifecycle against the real account, REQUIRES the Read and Write key.
   Existing tools are the instrumentation, so each step is observed:
   a. `b2_upload_file` a fresh file; note its fileId
   b. `b2_list_files` — the file IS listed
   c. `b2_hide_file` — expect a hide marker id
   d. `b2_list_files` — NOT listed. This is what hiding means.
   e. `b2_unhide_file` — expect restored true
   f. `b2_list_files` — listed again, SAME fileId as (a). Hiding cost nothing.
   g. `b2_delete_file_version` with that fileId, archive root configured
   h. `b2_list_files` — gone
6. Real-data invariants, the checks that matter most here:
   - `cat` the audit log: an intent line AND an outcome line for the delete,
     both valid JSON, carrying the real sha1 from step (a)'s upload receipt.
   - `shasum` the archived copy against the original local file — identical.
     This is the difference between a manifest and a backup, proven.
   - Backblaze console: the file is absent.

### VERIFIED — every step observed

1. `npm test` — 10 files, 92 tests, zero failures.
   DISCREPANCY, recorded not hidden: the case list above predicted 6 audit and
   13 delete cases; the suite has 8 and 16. The extras (hide working without a
   log configured, archivedTo null when archiving is off, the archive name
   carrying the version id, unhide reporting restored true) were gaps in the
   plan's case list, not a miscount. Fourth slice running where my case lists
   were short in the same direction.
2. `npm run build` — exit 0, dist purged first.
3. Delete with B2_AUDIT_LOG unset returned
   "Refusing to destroy data with no record: set B2_AUDIT_LOG to a file path".
   getFileInfo was never called: the refusal costs no API request.
4. Unknown bucket returned "No bucket named no-such-bucket-xyz in this account".
5. Full lifecycle against the real account, run by the user:
   upload trial.txt (39 bytes) -> listed -> hidden -> listed EMPTY -> unhidden
   -> listed again with the SAME fileId -> deleted -> listed EMPTY.
   Hiding and unhiding did not create a new version; the fileId after the round
   trip was byte-identical to the upload's.
6. Real-data invariants, all confirmed:
   - FOUR-way SHA-1 agreement on 811bc01ae38f63ed8474ece75d523b2611fde564:
     the original, the downloaded copy, the archived copy, and the sha1 B2
     itself reported in the receipt. `cmp` reported the files identical.
   - The audit log holds an intent line at 22:46:21.526Z and an outcome line at
     22:46:21.647Z -- 121ms apart, in that order, both carrying the full
     metadata and the sha1 captured BEFORE the version was destroyed.
   - archivedTo appears in the receipt and in both log lines.

The download refusal seen mid-run ("Disabled: set B2_DOWNLOAD_ROOT") was the
deny-by-default fence behaving correctly against an unconfigured root, not a
defect.

## Audit-log gate — verified live on 2026-08-11, during plan 010's close-out

This guard shipped with 006 but had never refused against a live run; it was
named as UNVERIFIED in CLAUDE.md > Verification until now. It has now fired:

    B2_AUDIT_LOG= npx tsx src/server.ts < <three JSON-RPC lines>
    -> "Refusing to destroy data with no record: set B2_AUDIT_LOG to a file path"

Run with `bucketName=no-such-bucket`. That choice is what makes it a proof of
ORDER rather than of the message: the same call with the audit log configured
returns "No bucket named no-such-bucket in this account", so getting the audit
refusal instead means the gate ran before any B2 request. b2-audit.jsonl stayed
at 18 lines, and nothing was destroyed.

TECHNIQUE, worth knowing before repeating this: `B2_AUDIT_LOG= b2 ...` through
the MCP inspector does NOT work. The inspector spawns the server with a
sanitized environment, so the variable never arrives and the server's own
loadDotEnv reads the real .env -- the run looks like the gate failed to fire
when it was never given the chance. Driving the server directly over stdio is
what let the override land. Node's process.loadEnvFile does not overwrite a
variable already present in the environment, including one set to the empty
string, which is why an empty value reaches auditLogPath's falsy check.
No edit to .env was needed, and none was made.
