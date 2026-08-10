# Plan 001 — list buckets over MCP

## Context

The repo is scaffolding only — CLAUDE.md (the constitution), WORKFLOW.md, empty
claude-plans/ROADMAP.md and claude-plans/STATE.md, and the two plan templates.
There is no package.json, no .gitignore, no source, no tests. Nothing about the
B2 MCP server described in the Overview exists yet. Current state: see
claude-plans/STATE.md (empty on this first plan).

This slice creates the smallest thing that is both unit-testable and provable in
a real MCP client: a stdio MCP server exposing exactly one tool,
`b2_list_buckets`, over a tested core module. It settles the Stack and Commands
sections of CLAUDE.md, which are currently placeholders.

Facts verified against the real packages before planning (not assumed):

- `@backblaze-labs/b2-sdk@0.2.0` — ESM-only, `"engines": {"node": ">=22.3.0"}`.
- Surface: `new B2Client({ applicationKeyId, applicationKey })` →
  `await client.authorize()` → `await client.listBuckets()` → `Bucket[]`.
- `@modelcontextprotocol/sdk@1.30.0` — peer dep `zod ^3.25 || ^4.0`.
- The machine's default Node was v20.19.6, below the SDK's floor. Confirmed
  with the user: use Node 22 via nvm and pin it in the repo. CORRECTION found
  at implementation time: nvm already had v22.19.0 installed, so no
  `nvm install` was needed — only `nvm use 22`.

**Decisions (confirmed with the user):**

- Language / stack: TypeScript + vitest. TypeScript because the SDK ships types
  and they are its main ergonomic benefit; vitest because it handles TS + ESM
  with zero config and gives clean mocking for faking `B2Client`.
- Node 22 via nvm, pinned by .nvmrc and package.json `engines`.
- Scope of slice 001: config from env, an authorized-client factory, a
  `listBuckets` core function, and a stdio MCP server exposing one tool.
- Chosen on your behalf (flag to revisit): the tool returns a JSON array of
  `{ bucketId, bucketName, bucketType }` as text content — no pretty-printed
  prose, no pagination, no quota fields. Quota lands in a later plan.
- Chosen on your behalf (flag to revisit): the client authorizes lazily on the
  first tool call and the authorized client is cached for the process lifetime,
  so a server started without valid credentials still starts and reports the
  failure through the tool result rather than crashing at boot.

## Dependencies

- `@backblaze-labs/b2-sdk@^0.2.0` — the thing this project wraps; provides
  `B2Client` and the bucket types.
- `@modelcontextprotocol/sdk@^1.30.0` — official MCP server implementation and
  the stdio transport.
- `zod@^3.25` — required peer of the MCP SDK; declares tool input schemas.
- `typescript@^5.9` (dev) — the build.
- `vitest@^3` (dev) — test runner.
- `tsx@^4` (dev) — run the server from source during development, no build step.
- `@types/node@^22` (dev) — Node globals (`process.env`) under TypeScript.

## Goal of this slice

An MCP-compatible client can connect to this server over stdio, call
`b2_list_buckets`, and get back the account's real B2 buckets. It deliberately
does NOT do: uploads, downloads, file management, quota, key management, bucket
filters, pagination, or any transport other than stdio.

## Design

### src/config.ts

`loadConfig(env: NodeJS.ProcessEnv = process.env): B2Config` returning
`{ applicationKeyId, applicationKey }`.

- Reads `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`. Credentials come from
  the environment only — never a literal, never a plan file (House rules).
- Throws `ConfigError` naming WHICH variable is missing, and never echoes a
  value in the message. A misconfigured server must fail loudly at the point of
  use rather than silently listing zero buckets.
- Takes `env` as a defaulted parameter purely so tests can pass a fake
  environment without mutating `process.env`.

### src/b2/client.ts

`getClient(config: B2Config): Promise<B2Client>` — constructs a `B2Client`,
awaits `authorize()`, and memoizes the result in a module-level variable so
repeated tool calls reuse one authorized session.

- Also exports `resetClient(): void`, used only by tests to clear the memo.
  Without it the module cache leaks state between test cases.
- Authorization happens here, not at server start, per the lazy-auth decision
  above.

### src/b2/buckets.ts

`listBuckets(client: B2Client): Promise<BucketSummary[]>` where
`BucketSummary = { bucketId: string; bucketName: string; bucketType: string }`.

- Maps the SDK's `Bucket` handles down to three plain fields. The MCP boundary
  must emit serializable data, and a `Bucket` handle carries methods and a live
  client reference that cannot cross it.
- Exact field mapping, read from the SDK's own .d.ts at implementation time:
  `Bucket` exposes `id`, `name`, and `info` — there are NO flat `bucketId` /
  `bucketName` / `bucketType` properties. So the mapper is
  `{ bucketId: b.id, bucketName: b.name, bucketType: b.info.bucketType }`.
- The parameter is typed against a narrow structural interface (`BucketLister`)
  rather than the concrete `B2Client`, so the test fake type-checks without
  constructing an authorized client. `tsc` confirms the real `B2Client`
  satisfies it, since `src/server.ts` passes one in.
- Takes the client as an argument rather than calling `getClient()` itself —
  that is what makes it testable against a fake with no network and no env.
- Sorts by `bucketName` ascending, so output is deterministic and two runs are
  diffable.

### src/server.ts

Builds an `McpServer` named `b2-mcp-server`, registers `b2_list_buckets` with an
empty zod input schema, connects a `StdioServerTransport`, and is the package
entry point.

- `toMessage()` must NOT read `error.message` alone. The B2 SDK's error family
  carries an empty message and puts the diagnosis on `name` / `code` / `status`;
  reading `.message` returned a blank error for every B2-side failure. Found by
  verification step C, not by the tests. See CLAUDE.md > What NOT to do.
- `main()` runs behind an entry-point guard so importing this module in a test
  does not spawn a stdio server as a side effect.
- Tool handler: `loadConfig()` -> `getClient()` -> `listBuckets()` -> return
  `{ content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }] }`.
- Errors (missing env, bad credentials, network failure) are caught and returned
  as `{ isError: true, content: [{ type: "text", text: message }] }`. A thrown
  error would kill the stdio session; an error result lets the AI client see and
  explain the problem.
- Nothing is ever written to stdout except MCP protocol traffic — stdout is the
  transport. Any diagnostics go to stderr.

Every exported function gets a purpose comment saying what it does and when you
would change it; the small internal mapper in buckets.ts gets a one-liner
(House rules).

### tests/config.test.ts

- both vars present -> returns them unchanged
- `B2_APPLICATION_KEY_ID` missing -> throws, message names that variable
- `B2_APPLICATION_KEY` missing -> throws, message names that variable
- both missing -> throws
- empty-string value -> treated as missing, throws
- the thrown message contains neither variable's value

### tests/buckets.test.ts

Uses a hand-written fake `B2Client` (an object with a `listBuckets` method) — no
network, no credentials.

- three buckets -> three summaries with exactly the three fields, no `Bucket`
  methods leaking through
- returned order is sorted by `bucketName`, given unsorted input
- zero buckets -> returns `[]`
- SDK rejects -> the rejection propagates (the server layer, not this one, turns
  it into a tool error)

## Files

- package.json — new; deps above, `engines.node >= 22.3.0`, `"type": "module"`,
  scripts `test`, `build`, `start`, `dev`.
- tsconfig.json — new; strict, NodeNext module resolution, out to dist/.
- .nvmrc — new; contains `22`.
- .gitignore — new; `.DS_Store`, `node_modules/`, `dist/`, `.env`.
- .env.example — new; the two variable NAMES with empty values, committed as
  documentation. No real values, ever.
- src/config.ts — new; `loadConfig`, `ConfigError`, `B2Config`.
- src/b2/client.ts — new; `getClient`, `resetClient`.
- src/b2/buckets.ts — new; `listBuckets`, `BucketSummary`.
- src/server.ts — new; the MCP server and entry point.
- tests/config.test.ts — new; the config cases above.
- tests/buckets.test.ts — new; the bucket cases above.
- tests/server.test.ts — new. ADDED DURING IMPLEMENTATION, not in the original
  plan: regression coverage for the blank-error bug found by verification step
  C. Recorded here rather than left as an undocumented implementation choice.
  Now listed in CLAUDE.md > Protected files.

.env is NOT created by this plan — that is yours to fill in. .env.example names
the variables so you know what belongs there.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. This slice newly parks:

- Planned: file operations (list, upload, download, delete).
- Planned: bucket quota reporting — the "buckets over 80% quota" use case in the
  Overview.
- Planned: application key management (create, list, delete).
- Possible: `bucketId` / `bucketName` / `bucketTypes` filters on
  `b2_list_buckets`.
- Possible: HTTP/SSE transport alongside stdio.
- Possible: .env file loading via dotenv (today the env must already be set by
  the MCP client config).

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED. .env.example holds no values and does not qualify.
  .env is already covered by the always-protected rule and this slice does not
  create it. No new file this slice creates qualifies.
- APPLIED. Fill CLAUDE.md Stack section — done in the 001+002 harvest, with the
  Node 22 floor recorded as a hard requirement of the B2 SDK.
- APPLIED. Fill CLAUDE.md Commands section — done in the same harvest, with
  expected test counts and the smoke-check command.
- APPLIED. CLAUDE.md What NOT to do and Established conventions also filled in
  that harvest. Do not redo any of these.
- claude-plans/ROADMAP.md — add the parked items above. Not protected: apply
  directly, then report.
- STATE.md — REQUIRED. Update claude-plans/STATE.md with every file this plan
  added, one line each. Pre-approved: apply directly, then report.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this slice now does

An AI client connected to this server can ask "list my B2 buckets" and get back
the real bucket names from the Backblaze account whose credentials are in the
environment. Before this slice, the repo contained no runnable code at all.

### Steps — confirm it by hand

1. `nvm use 22 && node -v` — expected: prints `v22.19.0` (any >= 22.3.0 works).
2. `npm install` — expected: installs with no EBADENGINE warning and no errors.
3. `npm test` — expected: `Test Files  3 passed (3)`, `Tests  15 passed (15)`,
   exit 0.
4. `npm run build` — expected: exits 0 silently, `dist/server.js` exists. This
   is what proves the real `B2Client` satisfies the structural `BucketLister`
   type; vitest alone would not catch it.
5. Smoke check — requires real credentials in the environment and step 2 done.
   Input:
   `B2_APPLICATION_KEY_ID=<your id> B2_APPLICATION_KEY=<your key> npx @modelcontextprotocol/inspector --cli npm run dev --method tools/call --tool-name b2_list_buckets`
   Output: a JSON array of objects each having exactly `bucketId`, `bucketName`,
   `bucketType`, sorted by `bucketName`, matching the buckets shown in the
   Backblaze web console. If the account has no buckets, `[]`.
6. Real-data invariant check, beyond the two required commands: compare the
   bucket names printed in step 5 against the Backblaze web console — count and
   names must match exactly. A fixture-only pass proves the mapper is
   self-consistent, not that it reflects the real account.

### Dynamism — confirm credentials are not baked in

Proves the server uses whatever credentials its environment supplies rather than
any single hardcoded account. Steps A, B and C need no B2 account; only D does.

A. `grep -rn "applicationKey" src/` — expected: hits only in src/config.ts and
   src/b2/client.ts, and every one is a variable or field NAME. No value, no
   key. `git status --short` shows no .env and no credential file.

B. Call `b2_list_buckets` with both variables unset — expected:
   `isError: true`, text
   `Missing required environment variable B2_APPLICATION_KEY_ID`.

C. Call it with deliberately wrong credentials
   (`B2_APPLICATION_KEY_ID=000000000000000000000000`,
   `B2_APPLICATION_KEY=deadbeefdeadbeefdeadbeefdeadbeef`) — expected:
   `isError: true`, text `BadAuthTokenError (bad_auth_token) HTTP 401`.

D. Call it with real credentials — expected: the bucket array from step 5.

The proof is that B and C return DIFFERENT messages. B means no credential was
supplied; C means the supplied credential reached Backblaze and Backblaze
rejected it. Same binary, different environment, different behavior. No second
B2 account required.

NOTE: step C is what caught the blank-error bug. Before the toMessage fix it
returned `isError: true` with an EMPTY string, and the whole test suite was
green. Do not delete this step.
