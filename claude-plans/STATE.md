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