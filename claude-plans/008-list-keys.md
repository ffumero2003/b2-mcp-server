# Plan 008 — list application keys

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"008 - b2_list_keys: list application keys with their capabilities and
restrictions. Wraps B2Client.listKeys, whose response contains NO secrets."

**This is the last Planned item.** When it lands, CLAUDE.md > Workflow
conventions' definition of done — "the Planned out-of-scope list is empty across
all plans" — is satisfied and the project is complete at its committed scope.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do. The roadmap's claim that the response holds no secrets was CHECKED, not
assumed, because the whole slice rests on it:

- `ApplicationKey` (dist/types/key.d.ts:74-98) carries keyName,
  applicationKeyId, capabilities, accountId, expirationTimestamp, bucketIds,
  a DEPRECATED bucketId, namePrefix and options. **There is no secret field.**
- The secret exists only on `FullApplicationKey`, which the SDK documents as
  "never returned again after this response" and which only `createKey` returns.
  That is why key creation stays parked on ROADMAP.md.
- `B2Client.paginateKeys(options?)` yields every key, handling paging.
- `B2Client.hasCapabilities(needed)` returns `{ ok, missing }` and exists
  precisely "so callers can fail fast with a clear error instead of a generic
  401/403".
- `Capability.ListKeys` is `"listKeys"`.

### The blocker you will probably hit

Listing keys requires the `listKeys` capability. The Read and Write key created
for plan 004 was scoped for file operations, and key management is a separate
capability that a file-scoped key does not normally carry. So this tool will
likely fail against your current credentials until a key with `listKeys` exists.

That is expected, not a defect — and it is the reason for the capability
pre-check below. A raw 401 would send you looking for a bug; "this key is
missing listKeys" tells you exactly what to change.

**Decisions (chosen on your behalf, flagged — see Open questions):**

- Bucket IDs are resolved to bucket NAMES, with the raw id kept alongside.
- The capability is pre-checked so the failure is legible.
- The deprecated `bucketId` field is not exposed.
- Expiry is reported as an ISO timestamp plus a derived `expired` boolean.

## Dependencies

None — reuses the existing stack.

## Goal of this feature

An AI client can ask what application keys exist, what each can do, and which
are restricted or expired. It deliberately does NOT create, delete, or modify
keys, and never surfaces a key secret, because the listing API does not carry
one.

## Design

### src/b2/keys.ts (new)

    MAX_KEYS = 1000

    KeySummary = { keyName, applicationKeyId, capabilities, expiresAt, expired,
                   bucketNames, bucketIds, namePrefix, options }
    KeyListing = { keys: KeySummary[], truncated: boolean }

    listKeys(client: KeyLister, now?: Date): Promise<KeyListing>

- Cites **Structural parameter types at module seams**, **Summary types at the
  MCP boundary**, **Deterministic order is ours, not the API's** (sorted by
  keyName), **Partial results announce themselves** (`truncated`), and **Policy
  constants in code, overridable per call** (MAX_KEYS) — all CLAUDE.md >
  Established conventions.
- `now` is a **Defaulted-collaborator parameter** so the `expired` computation
  is testable without mocking the clock.
- **Bucket ids are resolved to names.** A restriction reported as
  `["ddf8f3f77965792b9efc001b"]` tells a person nothing; `["felipe-prompt-gate"]`
  tells them everything. One `listBuckets()` call builds the map. An id that
  does not resolve — a deleted bucket, or one this key cannot see — keeps its
  id and contributes no name, rather than inventing one or dropping the
  restriction silently. Both arrays are returned so nothing is lost in
  translation.
- The DEPRECATED `bucketId` singular field is excluded. The SDK marks it
  deprecated in favour of `bucketIds`, and an explicit field list is what the
  Summary types convention is for.
- `expirationTimestamp` (epoch ms, nullable) becomes `expiresAt` as ISO 8601 or
  null, matching how every other tool in this project renders time. `expired` is
  derived so "which keys have expired" needs no date arithmetic from the model.
- **No field of the SDK response is passed through wholesale.** The mapper names
  every field it emits. If a future SDK version adds a secret-bearing field to
  the list response, it cannot leak through this boundary by accident. That is
  the strongest argument for the Summary types convention and it is worth
  stating here explicitly, in the one module where a leak would matter most.

### src/server.ts (modified)

Registers `b2_list_keys`, following **Tool registration shape**.
`readOnlyHint: true`. Input schema is empty — there is nothing to filter by that
is worth the surface.

Before listing, the handler calls `hasCapabilities([Capability.ListKeys])` and,
when `ok` is false, returns an error result naming the missing capability and
saying the key needs it. This is a NARROW use of the capability-gating idea
parked on ROADMAP.md: applied to the one tool most likely to hit a capability
wall, not generalised to all eight. Generalising stays parked.

The description states that the output contains no key secrets and that it does
reveal what each key is permitted to do.

### tests/keys.test.ts (new)

A fake client shaped from the observed SDK surface. Cases listed exhaustively
rather than by highlight, per the habit change recorded in plan 007.

- maps every summary field from one key
- **emits no field named applicationKey, even when the fake includes one** —
  the guard that the mapper enumerates rather than spreads
- excludes the deprecated singular bucketId field
- sorts keys by keyName given unsorted input
- converts expirationTimestamp to ISO 8601
- reports expiresAt null for a key that never expires
- expired is false for a future expiry, given a fixed now
- expired is true for a past expiry, given a fixed now
- expired is false when expirationTimestamp is null
- resolves bucketIds to bucketNames
- keeps the id and omits a name when a bucket id does not resolve
- reports empty arrays for an unrestricted key
- passes namePrefix and options through
- an account with no keys returns an empty list, not an error
- hitting MAX_KEYS sets truncated
- exactly MAX_KEYS keys is NOT truncated
- an SDK rejection propagates

## Files

- src/b2/keys.ts — new; listKeys, KeySummary, KeyListing, KeyLister, MAX_KEYS.
- src/server.ts — modified; register b2_list_keys with the capability pre-check.
- tests/keys.test.ts — new; the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Filtering the listing by capability, bucket, or expiry. The list is small
  enough that a model can filter what it reads.
- Warning about over-privileged keys, or any judgement about the account's
  security posture. Reporting facts is this tool's job.

## Follow-ups after implementation

- Protected files — REQUIRED. Strong candidate: the case asserting no field
  named applicationKey is emitted even when the source object carries one. It is
  a decoy whose removal leaves a green suite and no guard against a future
  refactor spreading the SDK object into the result. Assessed once passing.
- CLAUDE.md Commands — add the b2_list_keys smoke check and note the listKeys
  capability requirement.
- CLAUDE.md Established conventions — nothing new expected; this slice reuses
  six, more than any previous plan, which is the conventions doing their job.
- ROADMAP.md — move 008 to Done and confirm **Planned is now empty**, which is
  the project's definition of done. Report that explicitly rather than letting
  it pass unremarked.
- STATE.md — pre-approved, applied and reported.

## Open questions for you

1. **Is resolving bucket ids to names worth an extra API call?** It costs one
   listBuckets per invocation and turns an opaque hex string into a name. I
   recommend yes; the alternative is a caller chaining b2_list_buckets manually
   every time.
2. **Do you want the capability pre-check?** It borrows a parked idea for one
   tool. Without it, a key lacking listKeys produces B2's own error, which after
   plan 001's toMessage fix is readable but not explanatory. I recommend keeping
   it, scoped to this tool only.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can ask what application keys exist and what each is allowed to do,
including which buckets they are restricted to and which have expired. Before
this slice the server could act on storage but say nothing about who could.

### Steps — confirm it by hand

1. `npm test` — expected: all pass, zero failures. Exact count confirmed against
   real output; any difference from the case list above is reported, not edited.
2. `npm run build` — expected: exits 0 silently, dist purged first.
3. Capability refusal, which is the LIKELY path with the current key:
   `b2 b2_list_keys` — expected either a listing, or `isError: true` naming
   `listKeys` as the missing capability. Both outcomes verify something: the
   second proves the pre-check works and is not a bug.
4. Real account, once a key with listKeys exists: `b2 b2_list_keys` — expected a
   JSON array sorted by keyName, each entry carrying capabilities and either
   resolved bucketNames or empty arrays for an unrestricted key.
5. Real-data invariants:
   - **`grep -c applicationKey` on the tool output must be limited to
     `applicationKeyId`.** No bare `applicationKey` field may appear. This is
     the check the whole slice rests on and it is worth running by hand against
     real output, not just against a fixture.
   - Cross-check against the Backblaze console's Application Keys page: the same
     key names, the same capabilities, the same bucket restrictions.
   - Any key whose `expired` is true should show a past date in the console.

### VERIFIED — every step observed

1. `npm test` — 12 files, 131 tests, zero failures. tests/keys.test.ts holds
   exactly the 17 cases this plan listed. First exact prediction in the project;
   listing cases exhaustively rather than by highlight is what closed the gap.
2. `npm run build` — exit 0, dist purged first. tools/list reports NINE tools.
3. PREDICTION WRONG, in the safe direction: this plan expected the current key
   to lack the listKeys capability and the pre-check to refuse. It did not --
   the key carries listKeys and the call succeeded. The pre-check therefore
   remains UNVERIFIED against a real refusal; only its happy path was exercised.
   Recorded rather than glossed, because an untriggered guard is an untested one.
4. Real account: one key, "prompt-gate", 18 capabilities, no expiry, restricted
   to one bucket, options ["s3"], truncated false.
5. Real-data invariants, run against the live output rather than a fixture:
   - Fields emitted, exhaustively: applicationKeyId, bucketIds, bucketNames,
     capabilities, expired, expiresAt, keyName, namePrefix, options. Nine
     fields, exactly the nine the mapper names.
   - A bare `applicationKey` field: ABSENT. The claim the whole slice rests on,
     confirmed against real B2 data.
   - The deprecated singular `bucketId`: ABSENT.
   - Bucket id resolution worked live: ddf8f3f77965792b9efc001b resolved to
     "felipe-prompt-gate", so the restriction reads as a name rather than hex.

Not exercised against real data, and stated rather than implied: the truncation
cap (one key against a 1000 cap), the unresolvable-bucket-id path, expiry
handling (the only key never expires), and the capability refusal.
