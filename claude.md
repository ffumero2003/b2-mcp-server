# CLAUDE.md

Make sure you start every response saying my name.

<!-- Drift canary: this is deliberate. If a response stops opening with my name,
     the model has stopped reading this file and the session should be restarted.
     Do not remove this line or move it below the Overview. -->

## Overview

An MCP server that wraps @backblaze-labs/b2-sdk and exposes B2 Cloud Storage operations — list buckets, upload/download files, manage files, check quota, manage application keys — as tools any MCP-compatible AI client can call. Lets someone manage B2 storage by just talking to an AI ("show me buckets over 80% quota") instead of writing SDK code or using the web console.

## Stack

TypeScript 5.9 on Node 22 (ESM, NodeNext module resolution), vitest 3.
@backblaze-labs/b2-sdk 0.2.0, @modelcontextprotocol/sdk 1.30.0, zod 3.

Node 22 is a hard floor, not a preference: the B2 SDK declares
engines >= 22.3.0. Pinned by .nvmrc and package.json engines.

## Commands

- `npm test` — vitest run. Expect "Test Files 4 passed (4)", "Tests 19 passed (19)".
- `npm run build` — tsc. Silent on success.
- `npm start` — node dist/server.js. Stdio MCP server.
- `npm run dev` — tsx src/server.ts. Same, straight from source.
- Smoke check — `npx @modelcontextprotocol/inspector --cli npm run dev --method
  tools/call --tool-name b2_list_buckets`. Needs credentials in .env or the
  environment; returns the account's buckets as JSON.

## Verification

This section is the single source of truth for verification. Plan files carry the
SHAPE of it (Outcome + numbered Steps); the rules below are what fills that shape.
Never restate these rules inside a plan file — cite this section instead.

- Every slice ends with two commands, copy-pasteable and runnable as-is from the
  repo root:
  1. the test command — the one that exercises everything (all options, all error cases)
  2. a manual smoke check — a by-hand spot-check of the happy path only, not coverage
- Every command is listed with its EXPECTED output, so correctness is confirmed by
  eye and not just "the command ran" (e.g. "12 passed", "prints 2").
- ONLY list commands that actually work after THIS slice. If the app is not yet
  runnable (logic-only slice, no entry point), say so explicitly — the launch
  command arrives with the interface slice that creates it.
- For any interface slice (CLI or GUI), the smoke check states the INPUT (the action
  taken) and the OUTPUT (what should result), so the interface is confirmed to wire
  to the core:
  - CLI — input: `habit done read` after marking Jul 19-20; output: prints "streak: 2".
  - GUI — input: click "read", then "Mark done" on Jul 20 (Jul 19 already marked);
    output: the streak label updates to "2".
  For a GUI, the smoke check is a launch command plus the expected VISIBLE result
  instead of a printed value.
- The expected output must match what the tested core already guarantees — the
  interface adds no new logic, so its result is just the core's result made visible.
- Before reporting a slice as verified, actually run every command listed in
  its Verification steps and compare the real output to the stated expected
  output — do not report a step as passing on the strength of the design, the
  plan's prediction, or the fact that tests are green. A passing test suite
  proves the assertions are satisfied, not that the assertions are correct: an
  invariant can be silently loosened (e.g. a tolerance added to make a failing
  check pass) and still show green.
- Where an invariant can be checked directly against real data (not synthetic
  fixtures), do that check before calling the slice done, even if it isn't one
  of the two required Verification commands. Fixture-only tests can pass while
  the real corpus violates the invariant they're supposed to guard.
- If the real output does not match what was predicted, that is not a detail
  to fix quietly — it means the design or an existing test was wrong. Stop,
  diagnose why the prediction was wrong, and report the discrepancy before
  proposing a fix.

  
## Rules

<empty until the project earns one>

## What NOT to do

- Never put a value in .env.example. It is committed documentation holding
  NAMES ONLY; values go in .env, which is gitignored. This happened twice
  during plan 001, the second time a full master-key pair that then had to be
  regenerated. The two filenames sit next to each other and are easy to
  confuse, which is why this is a rule and not a reminder.
- Never trust a dependency's error shape without checking it against the live
  dependency. Two bugs in two plans, both invisible to a fully green suite:
  the B2 SDK throws errors with an EMPTY .message (the diagnosis lives on
  name/code/status), and process.loadEnvFile reports an UNREADABLE file as
  ENOENT rather than EACCES. Both were caught by a verification step run
  against real behavior, never by tests written from assumptions. Write the
  fixture from observed behavior, not from what the API ought to do.

## Protected files

Files listed here are never edited, overwritten, or deleted without my explicit
approval in the same turn. Each entry states WHY, so the rule survives without
the conversation that created it.

### Always protected — from day one, in every project

These are not "earned". They apply before the first line of code exists.

- CLAUDE.md — the constitution. Propose edits, never apply them silently.
- .env, and any .env.* variant — holds real credentials. Never read its values
  back to me, never overwrite it, never commit it. Propose the variable names a
  plan needs and let me fill them in myself.
- Any file holding credentials, keys, or tokens, whatever it happens to be named.

### Earned by this project

- tests/server.test.ts — the only regression coverage for the blank-error bug
  (plan 001). The B2 SDK's error classes carry an EMPTY .message and put the
  diagnosis on name/code/status, so reading .message alone returned an empty
  string to the user for every B2-side failure. The fixture in this file is
  deliberately shaped like a real B2 error rather than a plain Error. Replace
  that shape with a normal `new Error("msg")` and the suite still passes while
  the bug silently returns.
- tests/env-file.test.ts — the only regression coverage for the loadEnvFile
  errno bug (plan 002). Node's process.loadEnvFile() reports an UNREADABLE file
  as ENOENT, not EACCES, so trusting its errno downgrades "your .env has wrong
  permissions" to "you have no .env". The chmod 000 case is what proves
  loadDotEnv checks readability with accessSync instead. Delete that case and an
  unreadable .env silently reports absent again.

### Adding to this list is PRE-APPROVED

Appending an entry to this section is the one exception to CLAUDE.md being a
protected file. Do not propose it, do not save it for the next harvest, do not
bundle it with optional edits. Append it in the same turn the file comes to
exist, then tell me you did and why. Everything else in CLAUDE.md still requires
my approval before you touch it.

A file qualifies the moment ANY of these is true:

- It holds secrets, credentials, keys, or tokens.
- It is the only regression coverage for a bug already fixed — a fixture whose
  decoys could be removed without failing a single test.
- Overwriting it destroys something that cannot be regenerated from the repo.

A protected file that exists only in a proposal is not protected. If you noticed
it, list it.

## House rules

- No emojis in code, comments, or docs.
- Secrets live in .env (credentials only). Never hardcoded, never in a plan file, never committed.
- Policy (limits, scope rules) lives in code, not .env — a limit is not a secret.
- Run tests before calling anything done.

## Git

- Never run git add, commit, push, rebase, or gh pr create unless explicitly asked this turn.
- Edit files freely; suggest commands I can run.
- Commit messages naming a plan use the format `Plan 00N: <description>` so history maps to the numbered plans.

## Project setup

- At project start, create a .gitignore covering OS and language junk plus secrets:
  .DS_Store, **pycache**/, \*.pyc, .env
- Never create a .env unless the project has real secrets. If it does, it must be
  gitignored and hold credentials only (policy lives in code, not .env).

## Environment

- Never install packages outside the activated venv. Verify with `which python` before pip install.

## Docs

- Do not create documentation files unless asked.

## Workflow conventions

- Every substantial feature gets its own numbered plan in claude-plans/ as 00N-name.md, written before any code.
- Iteration logs go in claude-logs/, one per bug that survives 3 attempts.
- Out of scope splits into Planned (committed for this version) and Possible (noted, not committed).
- "Done" = the Planned out-of-scope list is empty across all plans. Possible items never block done.
- NO EXCEPTIONS: every plan must be written to claude-plans/00N-name.md as a real
  committed file in the repo BEFORE any code for that plan is written. The internal
  plan-mode preview is not sufficient — if the numbered file is not on disk in
  claude-plans/, the plan does not exist and implementation must not begin.
- Before implementing any plan, confirm the claude-plans/00N-\*.md file exists. If it
  does not, stop and create it first.
- A plan's Files section must name every concrete path — no "two section text
  files", no "config files as needed", no filename decided during
  implementation. If a file's exact name is not yet knowable (e.g. it depends on
  a value only known at runtime, like a ticker symbol), the plan states the
  NAMING RULE precisely enough that two different sessions would produce the
  identical name from it — not a free choice at implementation time.
- If implementation needs a file the plan didn't name, that is a plan gap, not
  an implementation decision. Stop, propose the addition to the plan file
  itself (get approval), then write the file — never write it first and explain
  the name choice afterward.
- When a plan's Design section describes a pattern already used by an earlier
  plan (a CLI shape, an error-handling convention, a module layout), that
  pattern is harvested into Established conventions as a Follow-up, the same
  way Stack and Commands are harvested. The next plan cites it by name instead
  of re-describing it.
- The full Planned/Possible roadmap lives in claude-plans/ROADMAP.md, not
  repeated in each plan's Out of scope section. A plan's Out of scope section
  lists only what THIS slice newly parks, plus a pointer: "full roadmap:
  see ROADMAP.md."

## Established conventions

Single source of truth for patterns repeated across plans. A plan's Design
section CITES an item here by name instead of re-describing it; only state
what THIS slice does differently from the convention, if anything.

- Defaulted-collaborator parameter — a collaborator (an env map, a filesystem
  root) is a parameter with a default, so tests substitute it without touching
  global state and production callers pass nothing. Used by
  loadConfig(env = process.env) in 001 and loadDotEnv(root = packageRoot()) in
  002. Cite by name; do not re-describe.
- Error results, never throws, across the MCP boundary — a tool handler catches
  everything and returns { isError: true, content: [...] }. A throw tears down
  the stdio session; a result lets the client read the reason and explain it.
  From 001.
- Structural parameter types at module seams — a module takes the narrow shape
  it actually uses (BucketLister, not B2Client), so a test fake satisfies it
  with no network and no credentials, while tsc still proves the real client
  fits because the server passes one in. From 001.
