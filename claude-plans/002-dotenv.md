# Plan 002 — load credentials from .env

## Context

Current state: see claude-plans/STATE.md. Plan 001 shipped a stdio MCP server
with one tool, reading credentials from `process.env`.

A `.env` file now exists at the repo root holding real credentials, correctly
gitignored (confirmed via `git check-ignore` and absence from `git status`).
Its values are never read back into the session.

Two gaps this slice closes:

1. Nothing loads `.env`. `src/config.ts` reads `process.env` directly, so the
   values in the file are inert and the server still reports
   `Missing required environment variable B2_APPLICATION_KEY_ID`.
2. `.env.example` no longer exists. It was renamed to `.env` rather than copied,
   so the committed template that documents which variables exist is gone.

**Decisions (confirmed with the user):**

- Build `.env` loading rather than relying only on MCP client config.
- No dotenv dependency. Node 22 ships `process.loadEnvFile()`. Verified against
  v22.19.0 before planning:
  - loads KEY=value pairs into process.env
  - a variable already set in the real environment WINS over the file, which is
    exactly the precedence needed so an MCP client env block still overrides
    .env
  - throws ENOENT when the file is absent, so the wrapper must swallow that

## Dependencies

None. Stdlib only (node:path, node:url).

## Goal of this feature

The server loads `.env` from the package root at startup, so credentials can
live in a gitignored file instead of being passed inline. Real environment
variables continue to take precedence. It deliberately does NOT add multi-file
or multi-profile support, and does not change how `loadConfig` works.

## Design

### src/env-file.ts (new)

`loadDotEnv(root = packageRoot()): 'loaded' | 'absent'`

- Resolves `.env` relative to the PACKAGE ROOT, not the current working
  directory. An MCP client launches the server from an arbitrary cwd, so a
  cwd-relative path would silently miss the file. Both `src/server.ts` and
  `dist/server.js` sit exactly one level below the root, so
  `fileURLToPath(import.meta.url)` -> `dirname` -> `..` resolves correctly under
  both `npm run dev` and `npm start`.
- Readability is decided by `accessSync(path, R_OK)`, NOT by catching from
  `loadEnvFile`. CORRECTION found at implementation time: Node 22.19.0's
  `process.loadEnvFile()` reports an UNREADABLE file as ENOENT rather than
  EACCES (verified directly; plain fs.readFileSync on the same file gives
  EACCES). Trusting its errno silently downgrades "your .env has wrong
  permissions" to "you have no .env", then fails downstream with a confusing
  missing-variable error. accessSync reports errnos faithfully: ENOENT returns
  'absent', everything else rethrows.
- Returns a status rather than logging, so the caller decides what to report and
  the function stays testable.
- Never logs which variables it loaded. Naming them is one step from leaking
  them, and values must never reach stderr.
- `root` is a defaulted parameter purely for testability, repeating
  `loadConfig(env = process.env)` from plan 001. See Follow-ups: this is the
  second use, so it is harvested into Established conventions.

### src/server.ts (modified)

Call `loadDotEnv()` as the first statement in `main()`, before the server is
built. Write only the STATUS to stderr (`.env loaded` / `.env absent`). Startup
must not fail when `.env` is absent: an MCP client env block is equally valid,
and plan 001's tool-level error already covers "no credentials anywhere".

### .env.example (recreated)

Variable names only, empty values, with comments warning against putting values
in it and against using the master application key.

### tests/env-file.test.ts (new)

Builds a temp directory via node:fs mkdtemp at runtime rather than committing a
fixture, so no `.env` fixture ever exists in the repo.

- .env with both variables -> 'loaded', both land in process.env
- no .env present -> 'absent', no throw
- a variable already set in the real environment is NOT overwritten by the file
- an unreadable file (chmod 000) rethrows rather than reporting 'absent' --
  this is the case that caught the errno bug above

A beforeEach/afterEach pair snapshots and restores process.env so cases cannot
leak into each other. That is a hook, not a fifth case: this file holds 4 tests.

## Files

- src/env-file.ts — new; loadDotEnv.
- src/server.ts — modified; call loadDotEnv() at the top of main().
- .env.example — recreated; names only, no values.
- tests/env-file.test.ts — new; the cases above.

`.env` is NOT touched by this plan. It is protected, holds real credentials, and
is never read, echoed, or overwritten.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Nothing newly parked; this feature
retires an existing Possible item.

## Follow-ups after implementation

- Protected files — REQUIRED. `.env.example` holds no values, so it does not
  qualify. src/env-file.ts does not qualify. CORRECTION: tests/env-file.test.ts
  DOES qualify -- once the errno bug above was found and fixed, its chmod 000
  case became the only regression coverage for it. Appended to CLAUDE.md, which
  is pre-approved. `.env` is already covered by the always-protected rule.
- APPLIED. Established conventions harvest: "Defaulted-collaborator parameter",
  plus "Error results, never throws, across the MCP boundary" and "Structural
  parameter types at module seams" from 001. Plan 003 cites these by name.
- APPLIED. CLAUDE.md "What NOT to do" now carries both scars: values in
  .env.example, and trusting a dependency's error shape without checking it.
- STATE.md and ROADMAP.md — pre-approved, applied directly and reported.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

Credentials in `.env` are picked up automatically at server startup, with no
inline variables and no MCP client config. Before this slice, `.env` was inert.

### Steps — confirm it by hand

1. `npm test` — expected: `Test Files  4 passed (4)`, `Tests  19 passed (19)`,
   exit 0.
2. `npm run build` — expected: exits 0 silently.
3. Absent path, verified in the suite against a temp directory: no `.env` ->
   `'absent'` and no throw. The user's real `.env` is never moved to test this.
4. Smoke check with real credentials, run by the user:
   `npx @modelcontextprotocol/inspector --cli npm run dev --method tools/call --tool-name b2_list_buckets`
   with NO inline variables. Expected: stderr shows `.env loaded`, and the tool
   returns the bucket array sorted by bucketName, matching the Backblaze console
   in both count and names. This also closes plan 001's pending live check.
