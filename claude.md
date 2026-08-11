# CLAUDE.md

Make sure you start every response saying my name.

<!-- Drift canary: this is deliberate. If a response stops opening with my name,
     the model has stopped reading this file and the session should be restarted.
     Do not remove this line or move it below the Overview. -->

## Overview

An MCP server that wraps @backblaze-labs/b2-sdk and exposes B2 Cloud Storage operations — list buckets, list/upload/download/delete files, report bucket size against a configured budget, inspect application keys — as tools any MCP-compatible AI client can call. Lets someone manage B2 storage by just talking to an AI ("which buckets are over 80% of their budget?") instead of writing SDK code or using the web console.

Note: B2's native API exposes no quota or usage endpoint — verified against the
full RawClient surface, where caps and alerts exist only in the web console.
Bucket size is computed by summing file sizes; the budget it is measured
against is project policy, defined in code.

## Stack

TypeScript 5.9 on Node 22 (ESM, NodeNext module resolution), vitest 3.
@backblaze-labs/b2-sdk 0.2.0, @modelcontextprotocol/sdk 1.30.0, zod 3.

Node 22 is a hard floor, not a preference: the B2 SDK declares
engines >= 22.3.0. Pinned by .nvmrc and package.json engines.

## Commands

- `npm test` — vitest run. All tests must pass; the count grows every slice, so
  check for zero failures rather than a fixed number. The expected count for a
  given slice lives in that plan's Verification section.
- `npm run build` — `rm -rf dist && tsc`. Purges first, per What NOT to do.
- `npm start` — node dist/server.js. Stdio MCP server.
- `npm run dev` — tsx src/server.ts. Same, straight from source.

Run `nvm use` first. The shell default may be older than the 22.3.0 floor, and
the failure does not name the version.

Tool names like b2_list_files are MCP tools, NOT shell commands. They exist only
inside the running server. Define this helper once per terminal session:

    b2() { local t="$1"; shift; npx @modelcontextprotocol/inspector --cli \
      npm run dev --method tools/call --tool-name "$t" "$@"; }
    BUCKET=<your bucket>

- List every tool and its schema — `npx @modelcontextprotocol/inspector --cli
  npm run dev --method tools/list`
- Read — `b2 b2_list_buckets`,
  `b2 b2_list_files --tool-arg bucketName=$BUCKET`, `b2 b2_bucket_usage` with no
  arguments to measure every bucket, and `b2 b2_list_keys`. Each argument needs
  its own --tool-arg. b2_list_keys needs a key carrying the listKeys capability
  and says so plainly when the key lacks it. Under a BUCKET-RESTRICTED key both
  whole-account calls cover only that one bucket and report which, via
  scopedToBucketId -- a narrowed listing must never read as a complete one.
  Before 009 they did not cover it at all: they returned 401. See 009.
- Write — b2_upload_file and b2_download_file need a Read and Write key plus
  their root set (B2_UPLOAD_ROOT to read from, B2_DOWNLOAD_ROOT to write to).
  b2_delete_file_version additionally REQUIRES B2_AUDIT_LOG, and honours
  B2_ARCHIVE_ROOT when set. All deny by default. A Read Only key fails at the
  B2 API, by design.
- GOTCHA: a relative localPath resolves against the ROOT, not your shell's cwd.
  With B2_UPLOAD_ROOT=".../uploads", pass `localPath=hello.txt`, NOT
  `localPath=uploads/hello.txt` -- the latter looks for uploads/uploads/hello.txt
  and fails with "No such file". The message shows the candidate as given and
  deliberately not the resolved path, because that would print the root.
- GOTCHA: do not quote a fileId. It is alphanumeric with underscores, so quotes
  only create a chance to leave a stray backslash and strand zsh at a `dquote>`
  prompt. Assign it bare: `FID=4_zddf8f...`
- Round-trip verification — upload, download, then
  `shasum uploads/<name> downloads/<name>` and `cmp uploads/<name> downloads/<name>`.
  Expect identical hashes matching the sha1 in the download receipt, and no
  `.partial` file left behind.
- Deletion verification — after b2_delete_file_version with an archive root set:
  `tail -2 b2-audit.jsonl` shows an INTENT line then an OUTCOME line, both valid
  JSON carrying the sha1 captured before the delete; and
  `shasum uploads/<name> archive/<name>.$FID` matches. A four-way SHA-1 match
  across original, download, archive and B2's own checksum is the strongest
  check this project has.
- Usage verification — b2_bucket_usage must never report FEWER bytes than
  b2_list_files sums, because list_files shows only current versions while
  usage counts old ones too. Compare them:
  `b2 b2_list_files --tool-arg bucketName=$BUCKET --tool-arg limit=1000`, add up
  the contentLength values, then `b2 b2_bucket_usage --tool-arg bucketName=$BUCKET`.
  Expect usage >= that sum, with the difference accounted for by old versions.
  A usage figure BELOW the sum means the action filter is wrong -- and no
  fixture can catch that, because a fixture agrees with whatever the filter does.
- Key-listing secret check — b2_list_keys must emit exactly nine fields and no
  bare `applicationKey`. Run it against the real account and enumerate what
  came back, rather than trusting a fixture:
  `b2 b2_list_keys` piped through a check that collects Object.keys of every
  entry. Expect applicationKeyId, bucketIds, bucketNames, capabilities, expired,
  expiresAt, keyName, namePrefix, options -- and NOTHING named applicationKey.
  B2 returns a key secret only from createKey, which this server never calls,
  but the check is against the mapper regressing, not against B2.

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
- A guard whose failure path never fired is UNVERIFIED, and the plan says so
  rather than implying full coverage. Still untriggered: 005's multi-bucket
  paths, 007's scan cap and multi-bucket totals, 006's audit-log gate, and
  009's unrestricted branch of listVisibleBuckets, which cannot run against
  the real account without re-authorizing as the master key.
  Green tests plus a happy-path smoke check is not the same as a proven guard.
  Name the untriggered paths explicitly in the plan's verification record.
- 008's capability pre-check is now VERIFIED, and how it got there is the point.
  It sat untriggered not by chance but because the credential in .env was the
  MASTER key, which carries every capability -- the guard could not fire, and
  the record's "happened to carry listKeys" understated that. Rotating to a
  scoped key made it refuse for real, with the predicted message, and in the
  same session exposed plan 009's 401. An untriggered guard is not merely
  unproven; it is a place where the setup, not the code, may be what is wrong.

  
## Rules

- A tool that reads or writes the local filesystem confines paths to a root
  configured in the environment, and DENIES BY DEFAULT when that root is unset.
  Resolve the root and the candidate with realpath BEFORE comparing them, so a
  symlink inside the root cannot point outside it. Compare as
  `target === root || target.startsWith(root + sep)` -- a bare startsWith
  accepts "/data/uploads-evil" for the root "/data/uploads". Rejection messages
  name the offending path, never the root: a caller has no need to learn where
  the fence sits. Read and write get SEPARATE roots, so the two can be granted
  independently. On the write side the target may not exist yet, so realpath its
  PARENT instead and check containment on parent + basename -- skipping that
  lets "<root>/../evil.txt" through, and a symlinked parent is the same escape
  the read side already guards. From 004 and 005; see src/path-fence.ts.
- A tool that destroys data takes the EXACT identifier of the thing destroyed
  and never resolves it from a friendlier name. b2_delete_file_version requires
  a fileId and refuses to look one up from a file name, so "delete hello.txt"
  cannot be satisfied in one step: the id has to come from a listing a human
  can see. A confirm flag is not a substitute -- the same model that calls the
  tool would set it. Such a tool also refuses to act unless an append-only
  record can be written, and writes INTENT before acting and OUTCOME after,
  success or failure: a log that can miss events is not a log. From 006; see
  src/b2/delete.ts and src/audit-log.ts.
- A boundary where a secret could appear ENUMERATES its output fields and never
  spreads a third-party object across it. src/b2/keys.ts names all nine fields
  it emits; it does not spread the SDK's ApplicationKey, even though that type
  carries no secret today. The guarantee then does not depend on the dependency
  never changing: if a future SDK adds a secret-bearing field to a list
  response, it cannot reach a client by accident. This generalises the Summary
  types convention into a hard requirement wherever credentials are in scope --
  which is exactly where key CREATION sits, still parked on ROADMAP.md for this
  reason. From 008; see src/b2/keys.ts.

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
- Never assume the build directory reflects current source. tsc does not delete
  output for sources you removed: after src/upload-path.ts was deleted in 005,
  dist/upload-path.js survived a rebuild -- a stale copy of the OLD fence with
  no write-side logic, sitting in dist waiting to be imported by accident.
  Nothing failed and nothing warned. `npm run build` now purges dist first;
  never trust a build after a rename or delete without confirming it did.
- Never assume a call that works under the master key works under a SCOPED key.
  An unfiltered b2_list_buckets returns 401 for a bucket-restricted key, and the
  listAllBucketNames capability does NOT exempt it. Three call sites shipped
  that way behind 131 green tests, because a fake listBuckets() agrees with
  whatever the caller does -- no fixture can catch an authorization rule. The
  filtered form, listBuckets({bucketId}), works, which is why every
  bucket-scoped tool was fine and only the two whole-account calls broke. This
  is the same scar as the SDK's empty .message, one level up: not the shape of a
  dependency's errors but the shape of its PERMISSIONS. Test with the credential
  the docs tell people to use, not the one that happens to be in .env. And check
  what the DEPENDENCY does on the same path: 009 fixed this project's three
  unfiltered calls, and a fourth was hiding inside B2Client.getBucket, which
  falls back to an unfiltered listBuckets when its filtered lookup misses. That
  turned every "no such bucket" into "unauthorized" for seven tools. Your call
  sites being clean is not the same as the call being clean. From 009 and 010.
- Never compare a path against a temp directory without realpath on macOS.
  /var is a symlink to /private/var, so mkdtemp returns "/var/..." while any
  fenced code returns "/private/var/...". This cost a failing test in 005, was
  fixed there with a realpathSync wrapper and a comment -- and then happened
  AGAIN in 006's new test file, because a comment in one file does not travel.
  Wrap every mkdtempSync in realpathSync when the path will be compared.

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
- tests/path-fence.test.ts — the only coverage for the containment fence in BOTH
  directions (plans 004, 005). Five cases are decoys whose removal leaves a green
  suite and an escapable fence: the symlink inside the root pointing out of it,
  the sibling directory "<root>-evil" that a bare startsWith would admit, the
  symlinked PARENT on the write side, the traversal that the target's
  non-existence would otherwise hide, and the assertion that no rejection message
  names the root. Nothing else in the repo would fail if the fence were quietly
  weakened.
- tests/delete.test.ts — the only coverage for the guarantees around the one
  tool that destroys data (plan 006). Three cases are decoys whose removal
  leaves a green suite and a weaker product: bypassGovernance is never sent
  (removing it lets an Object Lock override be added silently), a delete with
  no audit log configured never calls deleteVersion (removing it lets the gate
  become advisory), and a FAILED delete still writes an intent record plus a
  failure outcome (removing it lets the log quietly become success-only).
- tests/usage.test.ts — the only coverage for what counts as stored bytes
  (plan 007). Three cases are decoys whose removal leaves a green suite and a
  silently inflated number in every report: hide markers excluded, folder
  markers excluded, and start records excluded-but-counted-separately. A fourth
  guards the boundary that exactly MAX_PAGES_PER_BUCKET versions is a COMPLETE
  scan, not a truncated one. Nothing else in the repo would fail if the action
  filter started counting markers as data.
- tests/scope.test.ts — the only regression coverage for the scoped-key 401
  (plan 009). One case is a decoy whose removal leaves a green suite and the bug
  restored: the assertion that a restricted key is listed with `{bucketId}` and
  NOT with an empty options object. `listBuckets({})` is unfiltered on the wire
  and 401s exactly as before, while a test that merely checks "listBuckets was
  called" passes. Nothing else in the repo inspects the arguments that reach the
  SDK, and no fixture can catch an authorization rule. A second decoy from 010:
  an unknown bucket name must cost exactly ONE listBuckets call, because a
  second is the SDK's unfiltered fallback returning and the 401 with it.
- tests/keys.test.ts — the only guard that the key listing cannot leak a secret
  (plan 008). One case constructs a source object CARRYING an applicationKey
  field and asserts the mapper emits neither the field nor its value. Remove it
  and a later refactor to `{...key}` passes the suite while turning the one tool
  that touches credentials into a leak. A second case guards the exclusion of
  the SDK's deprecated bucketId.

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
  see ROADMAP.md." Once a plan number is assigned to an item — even before
  that plan's file exists — write it in place as "00N - <description>",
  splitting a bundled item into one line per number. Unwritten, the
  assignment is scratch and won't survive /clear.

## Established conventions

Single source of truth for patterns repeated across plans. A plan's Design
section CITES an item here by name instead of re-describing it; only state
what THIS slice does differently from the convention, if anything.

- Defaulted-collaborator parameter — a collaborator (an env map, a filesystem
  root) is a parameter with a default, so tests substitute it without touching
  global state and production callers pass nothing. Used by
  loadConfig(env = process.env) in 001, loadDotEnv(root = packageRoot()) in 002,
  and listKeys(client, now = new Date()) in 008, which makes an expiry
  computation testable without mocking the clock. Cite by name; do not
  re-describe.
- Error results, never throws, across the MCP boundary — a tool handler catches
  everything and returns { isError: true, content: [...] }. A throw tears down
  the stdio session; a result lets the client read the reason and explain it.
  From 001.
- Structural parameter types at module seams — a module takes the narrow shape
  it actually uses (BucketLister, not B2Client), so a test fake satisfies it
  with no network and no credentials, while tsc still proves the real client
  fits because the server passes one in. From 001.
- Account-wide calls respect the key's own scope, in ONE place — a call that
  covers "everything" (every bucket, every key) asks what the authorized
  credential is actually allowed to see and narrows the request itself, rather
  than asking broadly and hoping. src/b2/scope.ts is that place: three callers
  in 009 went through it instead of each reading getAllowedBucketId(). One
  chokepoint means a fourth caller cannot reintroduce the 401 by forgetting,
  and the rule is written down once where it can be tested. From 009.
- Summary types at the MCP boundary — an SDK handle or response is flattened
  into a plain interface of primitives before it crosses to a client
  (BucketSummary 001, FileSummary 003, UploadReceipt 004, DownloadReceipt 005,
  Hide/Unhide/DeleteReceipt 006, BucketUsage 007, KeySummary 008,
  BucketListing 009). SDK objects
  carry
  methods and a live client reference that cannot serialize, and an explicit
  field list keeps unplanned fields out of tool output. Name it <Thing>Summary
  or <Thing>Receipt.
- Deterministic order is ours, not the API's — a listing sorts explicitly before
  returning (bucketName 001, fileName 003, bucketName again 007, keyName 008),
  even when the
  API appears to return sorted results. One localeCompare costs nothing and removes a dependency on
  unverified behavior, per What NOT to do.
- Tool registration shape — every tool is registered with a zod inputSchema
  whose fields carry .describe(), MCP annotations stating readOnly/destructive/
  idempotent honestly, and a handler that chains loadConfig -> getClient -> a
  core function and returns JSON.stringify(result, null, 2) as text. Errors are
  caught per Error results, never throws. Used by b2_list_buckets 001,
  b2_list_files 003, b2_upload_file 004, b2_download_file 005, and the three
  mutation tools in 006, b2_bucket_usage 007, b2_list_keys 008 -- nine tools,
  all following this shape.
- Atomic write via temp file and rename — a stream is written to
  "<target>.<pid>.partial", counted, verified against the expected length, and
  renamed onto the target only when it matches; any failure removes the temp
  file and leaves the target untouched. Same directory, so the rename is a move
  rather than a copy. Used by b2_download_file 005 and by deletion archiving
  006, both through src/atomic-write.ts. Never write a stream straight to its
  final path.
- Partial results announce themselves — anything that can return less than the
  whole truth says so in the result, never by omission. b2_list_files carries
  truncated and nextFileName when a page is capped (003); b2_bucket_usage
  carries truncated per bucket, anyTruncated overall, and unfinishedLargeFiles
  for billed bytes it cannot sum (007); b2_list_keys carries truncated at
  MAX_KEYS (008); b2_list_buckets and b2_bucket_usage carry scopedToBucketId
  when the key's own restriction narrowed a whole-account listing to one
  bucket (009). A partial answer presented as a complete
  one is worse than refusing, because the caller cannot tell.
- Policy constants in code, overridable per call — limits, budgets and
  thresholds are named module constants, not environment variables, because a
  limit is not a secret and is not machine-specific (House rules). Callers may
  override per call and out-of-range values are CLAMPED rather than rejected.
  DEFAULT_LIMIT/MAX_LIMIT in 003, DEFAULT_BUDGET_BYTES/OVER_BUDGET_THRESHOLD/
  MAX_PAGES_PER_BUCKET in 007.
