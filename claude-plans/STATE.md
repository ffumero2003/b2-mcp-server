# Repo state

Living inventory: one line per file/module, what it does, which plan built it.
Updated as a REQUIRED Follow-up after every plan lands — same status as the
Stack/Commands harvest. A plan's Context section says "current state: see
STATE.md" instead of re-listing files.

Do NOT duplicate here: conventions (CLAUDE.md > Established conventions), run
commands (CLAUDE.md > Commands), the roadmap (ROADMAP.md). This file only
answers "what exists and what does it do."

## Plan 001 — list buckets over MCP

- package.json — deps, engines (node >= 22.3.0), ESM, scripts test/build/start/dev.
- tsconfig.json — strict TypeScript, NodeNext, src/ to dist/.
- .nvmrc — pins Node 22.
- .gitignore — .DS_Store, node_modules/, dist/, .env.
- .env.example — names the two B2 credential variables, no values.
- src/config.ts — loadConfig(env) reads B2 credentials from the environment;
  ConfigError names the missing variable and never echoes a value.
- src/b2/buckets.ts — listBuckets(client) flattens Bucket handles to
  { bucketId, bucketName, bucketType }, sorted by name. BucketLister is the
  narrow structural type that lets tests use a fake.
- src/b2/client.ts — getClient(config) authorizes once and memoizes; resetClient()
  clears the memo for tests. A failed authorize does not poison the cache.
- src/server.ts — MCP server over stdio, entry point. Exposes one tool,
  b2_list_buckets. Failures return isError results, never throw across the
  transport. createServer() is exported for future in-memory-transport tests.
  toMessage() is exported and reads name/code/status when an error's message is
  empty, which every B2 SDK error's is. main() sits behind an entry-point guard
  so importing the module does not spawn a server.
- tests/config.test.ts — 6 cases: both present, each missing, both missing,
  empty string treated as missing, no credential value in the error message.
- tests/buckets.test.ts — 4 cases: field mapping, sort order, empty account,
  SDK rejection propagates.
- tests/server.test.ts — 5 cases covering toMessage. Regression coverage for the
  blank-error bug; the fixture is deliberately shaped like a real B2 error
  (empty message, populated name/code/status). PROTECTED, see CLAUDE.md.

## Plan 002 — load credentials from .env

- src/env-file.ts — loadDotEnv(root) loads .env from the PACKAGE ROOT (not cwd,
  since MCP clients launch from anywhere) via Node 22's built-in
  process.loadEnvFile. Zero dependencies. Readability is checked with accessSync
  because loadEnvFile misreports an unreadable file as ENOENT. Returns
  'loaded' | 'absent'; never logs which variables it set.
- src/server.ts — modified: main() calls loadDotEnv() first and writes only the
  status to stderr.
- .env.example — recreated after being renamed away. Names only, with comments
  warning against values in it and against the master key.
- tests/env-file.test.ts — 4 cases: loads both vars, absent without throwing,
  real environment beats the file, unreadable file rethrows. Uses mkdtemp so no
  .env fixture is ever committed. PROTECTED, see CLAUDE.md.
- .env — NOT in the repo, gitignored, holds the user's real credentials. Never
  read or written by any plan.

## Plan 003 — list files in a bucket

- src/b2/files.ts — listFiles(client, {bucketName, prefix?, limit?}) returns one
  page of current files as {fileName, fileId, contentLength, contentType,
  uploadedAt}, sorted by fileName, plus truncated and nextFileName. Never
  auto-paginates. uploadTimestamp (epoch ms) becomes ISO 8601. DEFAULT_LIMIT 100
  and MAX_LIMIT 1000 are policy constants; a caller's limit is clamped, not
  rejected. BucketNotFoundError when getBucket returns null, so a missing bucket
  never reads as an empty one. BucketFinder/FileLister are the narrow structural
  types; FileVersionLike is the shape read off an SDK FileVersion.
- src/server.ts — modified: registers a second tool, b2_list_files, with a zod
  input schema (bucketName required, prefix and limit optional). First tool in
  the project to take arguments.
- tests/files.test.ts — 11 cases: field mapping and dropping extras, sort order,
  ISO timestamp conversion, prefix forwarding, default limit, clamped limit,
  truncated true/false (including a page landing exactly on the limit), unknown
  bucket, empty bucket, SDK rejection propagates. NOT protected: no bug was
  found this slice, so it is not sole regression coverage for anything.

## Plan 004 — upload a local file to a bucket

- src/upload-path.ts — SUPERSEDED by src/path-fence.ts in plan 005.
- src/b2/upload.ts — uploadFile(client, options, resolvePath, createSource)
  returns {fileId, fileName, bucketName, contentLength, contentType,
  uploadedAt}. Path policy runs before any network call, and the RESOLVED path
  is what gets read, closing a time-of-check/time-of-use gap. fileName defaults
  to the basename so a local path never becomes the B2 object name. contentType
  is forwarded only when supplied, leaving B2's b2/x-auto detection as default.
  Reuses BucketNotFoundError from files.ts. resolvePath and createSource are
  defaulted collaborators so tests never touch a real disk.
- src/server.ts — modified: registers a third tool, b2_upload_file, the first
  WRITE tool. Annotations readOnlyHint false, destructiveHint false (B2 versions
  rather than overwrites), idempotentHint false (two calls, two versions).
- .env.example — modified: documents B2_UPLOAD_ROOT, and that uploading needs a
  Read and Write key while listing does not.
- tests/upload-path.test.ts — SUPERSEDED by tests/path-fence.test.ts in 005.
- tests/upload.test.ts — 8 cases: receipt fields, basename defaulting, explicit
  fileName, contentType omitted and forwarded, forbidden path refused without
  calling upload, unknown bucket, SDK rejection propagates.
## Plan 005 — download a file to a local path

- src/path-fence.ts — replaces src/upload-path.ts and now guards BOTH
  directions. resolveExistingFile(candidate, rootVar, env) is the read side
  (uploads); resolveNewFilePath(candidate, rootVar, env) is the write side
  (downloads), which realpaths the PARENT because the target may not exist yet.
  Both deny by default. UPLOAD_ROOT_VAR and DOWNLOAD_ROOT_VAR are separate, so
  read and write access are granted independently. RootNotConfiguredError
  (renamed from UploadRootNotConfiguredError, now that it serves both roots) and
  PathNotAllowedError.
- src/b2/download.ts — downloadFile(client, options, resolvePath) returns
  {fileName, localPath, bucketName, contentLength, contentType, fileId, sha1,
  downloadedAt}. Streams to "<target>.<pid>.partial" and renames onto the target
  only after a complete transfer, because the SDK documents that a checksum
  failure errors the stream AFTER bytes have flowed. Any failure removes the
  temp file and leaves the target untouched. Bytes written are counted and
  checked against contentLength. localPath defaults to the BASENAME of the B2
  file name, which is attacker-controlled data and must not steer the target.
  File content is never returned. DestinationExistsError, IncompleteDownloadError.
- src/b2/upload.ts — modified: imports the fence from its new home.
- src/server.ts — modified: registers a fourth tool, b2_download_file, with
  destructiveHint TRUE (a replaced local file has no version history) and
  idempotentHint true.
- .env.example — modified: documents B2_DOWNLOAD_ROOT and the relative-path
  gotcha for B2_UPLOAD_ROOT.
- .gitignore — modified: adds uploads/ and downloads/ scratch directories.
- tests/path-fence.test.ts — 20 cases. The 12 read-side cases moved unchanged
  from tests/upload-path.test.ts; 8 write-side cases added, including the
  symlinked-parent escape and the traversal that the target's non-existence
  would otherwise hide. PROTECTED, see CLAUDE.md (the entry still names the old
  file; renaming it is proposed, not applied).
- tests/download.test.ts — 10 cases: receipt fields, basename defaulting,
  refusing and honouring overwrite, a mid-stream failure leaving no file and no
  .partial, a mid-stream failure not clobbering an existing file, a short body,
  unknown bucket, SDK rejection propagates.

## Plan 006 — hide, unhide, and delete a file version, with an audit trail

- src/audit-log.ts — appendAuditRecord(record, env) writes append-only JSON
  Lines; auditLogPath(env) throws AuditLogNotConfiguredError when B2_AUDIT_LOG
  is unset, which is what makes deletion refuse. One object per line, so a
  partial line can never destroy earlier records and the file greps without a
  parser. JSON.stringify escapes newlines, so a crafted file name cannot forge
  a second record. The path is deliberately NOT fenced: it is operator
  configuration, not a caller-supplied path.
- src/atomic-write.ts — writeStreamAtomically(body, target, expectedLength),
  extracted from 005's downloadFile so archiving reuses it rather than growing
  a second copy that drifts. Temp file, byte count, rename on match, cleanup on
  any failure. IncompleteWriteError, re-exported by download.ts under its old
  name IncompleteDownloadError.
- src/b2/download.ts — modified: calls the extracted helper.
- src/path-fence.ts — modified: adds ARCHIVE_ROOT_VAR.
- src/b2/delete.ts — hideFile, unhideFile, deleteFileVersion, each returning a
  receipt. Delete order is load-bearing: audit log resolved first (unconfigured
  means no API call at all), then getFileInfo (impossible after deletion), then
  archive if configured (non-destructive, so failure aborts safely), then the
  INTENT record, then the delete, then the OUTCOME record on success or
  failure. bypassGovernance is never sent. Archiving downloads BY ID so the
  exact version being destroyed is what gets kept. DeleteReceipt is built from
  pre-delete metadata because deleteVersion returns void -- it records what was
  requested and not rejected, NOT confirmation from B2.
- src/server.ts — modified: registers b2_hide_file, b2_unhide_file and
  b2_delete_file_version, bringing the server to seven tools. Only the delete
  carries destructiveHint true.
- .env.example — modified: documents B2_AUDIT_LOG and B2_ARCHIVE_ROOT.
- .gitignore — modified: adds archive/ and b2-audit.jsonl.
- tests/audit-log.test.ts — 8 cases including append-preserves-earlier-content
  and a newline in a field staying on one line.
- tests/delete.test.ts — 16 cases including the no-audit-log refusal never
  calling deleteVersion, a failed delete still leaving intent plus a failure
  outcome, bypassGovernance never sent, and archiving using the fileId rather
  than the current version. Proposed for Protected files, not appended.

## Plan 007 — report bucket size against a configured budget

- src/b2/usage.ts — bucketUsage(client, {bucketName?, budgetBytes?,
  thresholdPercent?}) returns a UsageReport of per-bucket BucketUsage entries
  sorted by name, plus totalBytesUsed and anyTruncated. B2 has no usage
  endpoint, so bytes are summed from file versions. isStoredBytes() is the core
  of it and names all five FileAction values explicitly: upload and copy COUNT;
  hide, folder and start do not. OLD versions are counted because B2 bills for
  every version retained. Unfinished large uploads are COUNTED, not summed --
  their billed bytes live in PARTS that the start record does not carry -- so
  bytesUsed is an honest floor and unfinishedLargeFiles says what it excludes.
  Scanning is capped at PAGE_SIZE * MAX_PAGES_PER_BUCKET versions and sets
  truncated rather than presenting a short total as a whole one; exactly the
  cap is a complete scan, one past it is truncated. humanBytes() renders GiB and
  MiB so a model answers in units a person reads instead of doing arithmetic on
  a raw count. DEFAULT_BUDGET_BYTES is 10 GiB, B2's free storage tier.
  Constants are policy and live in code, not the environment. Reuses
  BucketNotFoundError so a missing bucket never reads as one using zero bytes.
- src/server.ts — modified: registers an eighth tool, b2_bucket_usage, the only
  read-only tool added since 003. Its description states the exclusion of
  unfinished-upload parts and the per-1000-versions transaction cost, so a
  client can judge whether to scan a whole account.
- tests/usage.test.ts — 22 cases across four groups: what counts as stored
  bytes (including the three exclusions and old-version accounting), budget and
  threshold boundaries, bucket selection, and the scan cap (including the
  exactly-on-the-cap case that must NOT report truncated).
