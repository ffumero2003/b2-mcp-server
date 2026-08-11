# Plan 010 — visible bucket lookup

## Context

Current state: see claude-plans/STATE.md.

009 fixed the three places this project called `listBuckets()` unfiltered. Its
own verification then found a FOURTH unfiltered call, inside the SDK:

```js
async getBucket(bucketName) {
  const filteredMatch = (await this.listBuckets({ bucketName }))[0]
  if (filteredMatch !== void 0) return filteredMatch
  return (await this.listBuckets()).find((b) => b.name === bucketName) ?? null
}
```
(node_modules/@backblaze-labs/b2-sdk/dist/client.js:139-143)

When the filtered lookup misses, it falls back to an unfiltered listing — the
exact call B2 answers with 401 for a bucket-restricted key. Observed under the
scoped key:

    b2 b2_list_files --tool-arg bucketName=no-such-bucket
    -> BadAuthTokenError (unauthorized) HTTP 401

It should say "No bucket named no-such-bucket in this account". Every
bucket-scoped tool routes through `client.getBucket`, so all seven of them
(list_files, upload, download, hide, unhide, delete, single-bucket usage) return
a misleading auth error for any bucket name the key cannot see. `BucketNotFoundError`
is currently unreachable under the credential .env.example mandates.

Pre-existing rather than caused by 009: nothing in that slice touched getBucket.
It was invisible under the master key, where the fallback succeeded.

Why it matters beyond tidiness: a 401 tells the operator their credentials are
broken when the truth is a typo in a bucket name. That is the same class of
defect as 001's blank error message — a real cause replaced by a misleading one.

**Decisions (confirmed with the user):**

- Fix at the CLIENT boundary, not in the five modules. src/b2/client.ts is the
  one place an authorized client is constructed; replacing `getBucket` there
  leaves every module's structural seam and every existing test fake untouched.
  The alternative — threading scope through files/upload/download/delete/usage —
  would add `name` to four structural types and churn four test files including
  a protected one, to fix a bug none of them cause.
- Never ask B2 about a bucket a restricted key is not allowed to see. For a
  restricted key the lookup filters by the key's OWN allowed id and compares the
  name locally, so the request cannot be the kind B2 rejects.

## Dependencies

None — reuses existing stack.

## Goal of this feature

Naming a bucket that does not exist, or that the key cannot see, produces
"No bucket named X in this account" instead of a 401, for every tool that
resolves a bucket by name. It does not change what a valid lookup returns.

## Design

### src/b2/scope.ts (modified)

Adds `getVisibleBucket(client, bucketName)` beside the existing
`listVisibleBuckets`, keeping the rule about scoped calls in one module per
Established conventions > Account-wide calls respect the key's own scope.

```
unrestricted key: listBuckets({ bucketName })   -> [0] ?? null
restricted key:   listBuckets({ bucketId })     -> match only if name equals
```

- Neither branch ever calls `listBuckets()` unfiltered, which is the entire bug.
- The restricted branch does NOT pass the caller's bucketName to B2. Asking a
  restricted key about someone else's bucket is precisely the request that 401s;
  filtering by the key's own id always succeeds, and the name comparison happens
  locally on the one bucket that comes back.
- `ScopedBucketFinder<TBucket extends { readonly name: string }>` extends the
  existing `ScopedBucketLister` with the name constraint the comparison needs.

### src/b2/client.ts (modified)

After `authorize()`, replaces the instance's `getBucket` with one backed by
`getVisibleBucket`. Safe to do: B2Client declares every field publicly and uses
no `#private` fields (dist/client.js:25-40), so an own-property override
shadows the prototype method with `this` still bound to the real client.

Documented as a deliberate patch of third-party behavior, with the SDK line
numbers, so a future reader does not "clean it up" and restore the 401.

### tests/scope.test.ts (modified, PROTECTED)

Cases ADDED for getVisibleBucket, existing cases untouched:

- Unrestricted key: filters by name, returns the match.
- Unrestricted key, no match: returns null, and — DECOY — makes exactly ONE
  listBuckets call. A second call is the SDK's unfiltered fallback returning,
  and nothing else in the repo would fail.
- Restricted key: filters by the allowed id, returns the bucket when the name
  matches.
- Restricted key asking for a DIFFERENT bucket: returns null, and the bucketName
  is never sent to B2. That request is the one that 401s.

## Files

- src/b2/scope.ts — modified, adds getVisibleBucket and ScopedBucketFinder.
- src/b2/client.ts — modified, overrides getBucket on the authorized client.
- tests/scope.test.ts — modified, four cases ADDED.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md.

- Nothing newly parked. 010 closes the last known consequence of the scoped-key
  root cause.

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED. No NEW file qualifies; tests/scope.test.ts is
  already listed from 009, and its entry needs one clause added for the
  single-call decoy this slice adds.
- CLAUDE.md harvest — the What NOT to do entry from 009 gains the SDK's
  getBucket fallback as a second instance, since "the fix is not done when your
  own call sites are clean" is the reusable part.
- STATE.md — REQUIRED. Add a Plan 010 section.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

Asking any bucket-scoped tool for a bucket name that does not exist now says the
bucket does not exist, instead of reporting an authorization failure. Valid
lookups are unchanged.

### Steps — confirm it by hand

Prerequisite: `nvm use`, then the b2 helper and `BUCKET=felipe-prompt-gate`.

1. `npm test` — expected: zero failures. ACTUAL: 145 passed, 13 files (141 plus
   4 getVisibleBucket cases). `npx tsc --noEmit` clean.
2. `b2 b2_list_files --tool-arg bucketName=no-such-bucket` — input: a name no
   bucket has. Expected: "No bucket named no-such-bucket in this account".
   ACTUAL: exactly that, where it was HTTP 401 before. Also checked on a WRITE
   tool, b2_upload_file with the same bad name, which gives the same message —
   the fix sits below every tool rather than in the read path only.
3. Regression — `b2 b2_list_files --tool-arg bucketName=$BUCKET` still returns
   116 files summing 33,204,199 bytes, and
   `b2 b2_bucket_usage --tool-arg bucketName=$BUCKET` still reports 116 versions
   and the same byte count. A lookup that broke would show as zero files or an
   error, not a wrong number.
3. Regression — ACTUAL: 116 files summing 33,204,199 bytes, and single-bucket
   usage at 116 versions / 33,204,199 bytes. Unchanged.
4. `b2 b2_list_buckets` and `b2 b2_bucket_usage` with no arguments still work,
   confirming 010 did not disturb 009. ACTUAL: one bucket, scopedToBucketId
   ddf8f3f77965792b9efc001b.

### Guards this slice does NOT verify

- The UNRESTRICTED branch of getVisibleBucket is fixture-only, like 009's, and
  cannot run against the real account without re-authorizing as the master key.
- Everything 009 left open stays open: 006's audit-log gate, a Read Only key
  failing at the B2 API, 007's scan cap, and genuine multi-bucket totals.
