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

- src/upload-path.ts — resolveUploadPath(candidate, env) is the security
  boundary for local file access. Uploads DENY BY DEFAULT: without
  B2_UPLOAD_ROOT set, every upload is refused. Root and candidate both go
  through realpath BEFORE comparison, so a symlink inside the root cannot point
  outside it. Containment is `=== root || startsWith(root + sep)`, never bare
  startsWith, so a sibling named "<root>-evil" is refused. Rejection messages
  name the candidate but NEVER the root. UploadRootNotConfiguredError and
  PathNotAllowedError.
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
- tests/upload-path.test.ts — 12 cases including the traversal escape, the
  sibling-prefix directory, and the symlink-out-of-root escape. Proposed for
  Protected files, see the plan's Follow-ups.
- tests/upload.test.ts — 8 cases: receipt fields, basename defaulting, explicit
  fileName, contentType omitted and forwarded, forbidden path refused without
  calling upload, unknown bucket, SDK rejection propagates.