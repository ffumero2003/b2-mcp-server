# Plan 009 — scope-aware bucket listing

## Context

Current state: see claude-plans/STATE.md.

New since 008: the project rotated off the master application key onto a
bucket-restricted key (`b2-mcp-server`, restricted to `felipe-prompt-gate`).
That rotation proved one guard and broke two tools.

Proved — `b2_list_keys` refused with the exact message plan 008 predicted,
"This application key cannot list keys: missing capability listKeys." That
pre-check has now fired against a real refusal rather than being asserted.

Broke — `b2_list_buckets` and `b2_bucket_usage` with no `bucketName` both
return `BadAuthTokenError (unauthorized) HTTP 401`.

Measured, not reasoned:

| call | result |
| --- | --- |
| `b2_list_files --tool-arg bucketName=...` | works |
| `b2_bucket_usage --tool-arg bucketName=...` | works: 116 versions, 33,204,199 bytes, identical to the master-key measurement |
| `b2_list_buckets` | 401 |
| `b2_bucket_usage`, no bucketName | 401 |

The dividing line is filtered vs. unfiltered, not read vs. write.
`B2Client.getBucket` is implemented as `listBuckets({ bucketName })`
(node_modules/@backblaze-labs/b2-sdk/dist/client.js:139-143), so every
bucket-scoped tool takes the filtered path and works. The two failures are the
only calls reaching `listBuckets()` with no argument.

Root cause: B2 rejects an unfiltered `b2_list_buckets` from a bucket-restricted
key with 401, and the `listAllBucketNames` capability does NOT exempt it — this
key holds that capability and still gets 401. Authorization is healthy; the 008
capability pre-check read the key's own capabilities successfully in the same
process moments earlier.

Severity: .env.example forbids the master key, so the configuration the project
mandates is the one where two of nine tools fail, including the "which buckets
are over 80% of their budget?" question that is the Overview's stated purpose.
It shipped behind 131 green tests because a fake `listBuckets()` answers however
the fixture was written — the failure mode CLAUDE.md > What NOT to do already
warns about for dependency behavior, now recurring for dependency AUTHORIZATION.

**Decisions (confirmed with the user):**

- Scope of this slice: make all three unfiltered call sites scope-aware, and
  surface the applied scope in output. No new tool, no new capability.
- `b2_list_buckets` output changes from a bare array to an object. Chosen on
  your behalf and flagged: a bare array has nowhere to carry the caveat that a
  listing was narrowed, and Established conventions > Partial results announce
  themselves requires it to. This is the only output-shape change in the slice.
- Fix all three call sites, including the one in keys.ts that the current key
  cannot reach. Fixing two of three leaves a landmine for any bucket-restricted
  key that does carry `listKeys`.

## Dependencies

None — reuses existing stack. Both halves of the fix already exist in
@backblaze-labs/b2-sdk 0.2.0.

## Goal of this feature

Every tool works under a bucket-restricted key, and any listing narrowed by the
key's own scope says so in its result instead of looking like the whole account.
It does not add bucket filters as a caller-facing option; the filter applied here
is the key's own restriction, not a user parameter.

## Design

### src/b2/scope.ts (new)

`listVisibleBuckets(client)` — the one place that knows a restricted key must
filter. Returns both the buckets and the scope that was applied, so callers can
report it rather than each re-deriving it.

- Reads `client.accountInfo.getAllowedBucketId()`
  (dist/auth/account-info.d.ts:67), non-null exactly when the authorized key is
  bucket-restricted. `accountInfo` is a public readonly property of B2Client
  (dist/client.d.ts:84).
- Restricted: calls `listBuckets({ bucketId })` (dist/client.d.ts:148-151), the
  filtered form already proven to work. Unrestricted: calls `listBuckets()`.
- Passes `{ bucketId }` and never `{}` — an empty options object is unfiltered
  on the wire and would 401 exactly as today.
- Takes a structural parameter type per Established conventions > Structural
  parameter types at module seams, so tests need no authorized client.
- Errors propagate untouched; turning them into tool errors stays the server
  layer's job, per Error results, never throws.

### src/b2/buckets.ts, src/b2/usage.ts, src/b2/keys.ts (modified)

All three switch their unfiltered `client.listBuckets()` to
`listVisibleBuckets`. Sort order and every existing field stay as they are.

- buckets.ts — `listBuckets(client)` returns
  `{ buckets: BucketSummary[], scopedToBucketId: string | null }`.
- usage.ts — the `options.bucketName === undefined` branch; `UsageReport` gains
  `scopedToBucketId`.
- keys.ts:110 — id-to-name resolution only. No change to the emitted field list,
  which stays enumerated at nine fields per CLAUDE.md > Rules.

### src/server.ts (modified)

No logic change. The `b2_list_buckets` and `b2_bucket_usage` descriptions gain a
sentence stating that a bucket-restricted key sees only its own bucket, so a
model reading the schema does not present a narrowed listing as complete.

### tests/scope.test.ts (new)

- Restricted key: passes `{ bucketId }` matching the allowed id.
- Unrestricted key: calls with no options at all.
- `scopedToBucketId` matches the allowed id, and is null when unrestricted.
- DECOY: the restricted path must pass `{ bucketId }`, NOT `{}`. Assert on the
  argument actually received. A test that only checks "listBuckets was called"
  stays green while the 401 returns.

### tests/buckets.test.ts, tests/usage.test.ts, tests/keys.test.ts (modified)

- buckets.ts's 4 existing cases updated for the object shape, plus a restricted
  case. Not protected, so editing existing cases is fine here.
- usage.ts and keys.ts are PROTECTED: ADD one case each (scoped scan; restricted
  id-to-name resolution) and touch no existing case. usage.test.ts's four decoys
  stay exactly as written.

## Files

- src/b2/scope.ts — new, `listVisibleBuckets` and its structural types.
- src/b2/buckets.ts — modified, calls listVisibleBuckets, returns the object shape.
- src/b2/usage.ts — modified, scope-aware all-buckets branch, scopedToBucketId on UsageReport.
- src/b2/keys.ts — modified, scope-aware id-to-name resolution.
- src/server.ts — modified, two tool descriptions.
- tests/scope.test.ts — new, the cases above.
- tests/buckets.test.ts — modified, existing cases to the new shape plus a restricted case.
- tests/usage.test.ts — modified, one case ADDED.
- tests/keys.test.ts — modified, one case ADDED.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md.

- Caller-facing bucket filters on b2_list_buckets. 009 introduces the bucketId
  filter internally for the key's own restriction; exposing bucketName and
  bucketTypes as tool arguments stays the separate polish item already on the
  roadmap from 001.
- Multi-bucket-restricted keys. `getAllowedBucketIds()` (plural) exists in the
  SDK alongside the singular accessor; B2's console only issues single-bucket
  restrictions today, so this slice reads the singular and does not speculate.

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED. `tests/scope.test.ts` qualifies the moment it
  exists: it becomes the only regression coverage for this 401, and its decoy
  (asserting `{ bucketId }` rather than `{}`) is removable without failing
  anything else in the repo. Appending it is pre-approved; apply and report.
- CLAUDE.md harvest — three edits, listed with exact wording in the session plan
  and applied with approval in the same turn: a new What NOT to do entry about
  testing the credential you tell people to use; the Verification paragraph
  moving 008's pre-check from untriggered to verified; and the Commands note
  that a restricted key measures only its own bucket.
- STATE.md — REQUIRED. Add a Plan 009 section and correct the .env entry, which
  currently states the file holds the master key.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

Listing buckets and scanning every bucket for usage now work when the server is
run with a bucket-restricted application key, which is the configuration
.env.example mandates. Both currently fail with a 401. When the key is
restricted, the result names the bucket it was narrowed to instead of appearing
to cover the whole account.

### Steps — confirm it by hand

Prerequisite: `nvm use`, then the b2 helper and `BUCKET=felipe-prompt-gate`.

1. `npm test` — expected: zero failures. ACTUAL: 141 passed, 13 files (131 plus
   5 scope cases, 2 buckets, 2 usage, 1 keys). `npx tsc --noEmit` clean.
2. `b2 b2_list_buckets` — input: no arguments, under the scoped key. Expected: a
   JSON object whose `buckets` holds exactly `felipe-prompt-gate` and whose
   `scopedToBucketId` is `ddf8f3f77965792b9efc001b`. Today: 401.
3. `b2 b2_bucket_usage` — input: no arguments. Expected: that one bucket, 116
   versions, 33,204,199 bytes, `scopedToBucketId` set. Today: 401. The byte
   figure must equal the single-bucket call exactly — the cross-check that a
   scoped scan measures the same thing the filtered path does.
4. Regression — `b2 b2_list_files --tool-arg bucketName=$BUCKET` and
   `b2 b2_bucket_usage --tool-arg bucketName=$BUCKET` unchanged, and
   `b2 b2_list_keys` still refusing for lack of listKeys.

### Verification record — what actually happened

Every step above was run against the live account under the scoped key, not
predicted. Steps 2 and 3 both returned exactly what this plan said they would:
one bucket, `scopedToBucketId` = `ddf8f3f77965792b9efc001b`, and 116 versions /
33,204,199 bytes matching the filtered single-bucket call to the byte. Step 4's
regressions held, including b2_list_keys still refusing.

Two things the plan did not anticipate, both found by running step 4:

1. `b2_bucket_usage --tool-arg bucketName=...` reports `scopedToBucketId: null`
   even though the key IS restricted. Deliberate, and a judgment call made
   during implementation: the field means "your result was narrowed beyond what
   you asked for", which is false when the caller named the bucket and got it.
   Flagged rather than buried, because the opposite reading -- "the field
   describes the key" -- is defensible too.
2. NEW HOLE, now Planned as 010. `b2_list_files --tool-arg bucketName=no-such-bucket`
   returns a raw 401 instead of "No bucket named no-such-bucket in this
   account". B2Client.getBucket falls back to an UNFILTERED listBuckets when its
   filtered lookup misses (SDK client.js:139-143), which 401s for a restricted
   key. Pre-existing rather than caused by 009 -- nothing in this slice touched
   getBucket or files.ts -- but invisible under the master key, where the
   fallback succeeded. It makes BucketNotFoundError unreachable for exactly the
   credential this project tells people to use.

### Guards this slice does NOT verify

Named explicitly per CLAUDE.md > Verification rather than implied covered:

- The unrestricted branch of `listVisibleBuckets` cannot be exercised against
  the real account without re-authorizing as the master key. Fixture-only.
- The audit-log gate (006) has still never fired against a live refusal.
- A Read Only key failing at the B2 API is still unevidenced.
- The usage scan cap (>20,000 versions) and genuine multi-bucket totals (needs a
  second bucket, which this key could not see anyway) stay unverified.
