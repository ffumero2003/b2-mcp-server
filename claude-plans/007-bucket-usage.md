# Plan 007 — report bucket size against a configured budget

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"007 - b2_bucket_usage: report bytes used per bucket by summing contentLength
over file versions, and flag buckets above a configured percentage of a budget."

This is the slice the Overview was written around: "which buckets are over 80%
of their budget?" It is also the first tool that answers a question B2 itself
will not answer — there is no usage endpoint, so the number is computed here.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do:

- `Bucket.paginateFileVersions({ prefix?, pageSize?, signal? })` returns an
  `AsyncIterableIterator<FileVersion>` and handles paging internally.
- `FileAction` has FIVE values, and only two of them are stored bytes:
  - `upload` — a real object. COUNT.
  - `copy` — a real object made server-side. COUNT.
  - `hide` — a soft-delete marker. NOT data.
  - `folder` — a virtual directory marker. NOT data.
  - `start` — a large file begun and never finished. See the honesty note below.
- `Bucket.paginateUnfinishedLargeFiles({ namePrefix?, pageSize? })` exists
  separately; its pageSize is B2-capped at 100.
- `PaginatorOptions.pageSize` is capped by B2 at 10000 for file endpoints.

### The honesty problem this slice has to solve

**Unfinished large files are billed by B2 but cannot be summed from
listFileVersions.** A `start` record is a marker; the bytes that cost money are
its uploaded PARTS, reachable only through `paginateParts` per file — one extra
paginated call per unfinished upload.

So any number this tool produces is a floor, not a total. Two ways to be wrong
here, and both are worse than the design below:

- Silently omit them, and report a total that is quietly short.
- Sum `start` records' contentLength, which is not what is stored.

The design instead COUNTS unfinished large files and reports that count beside
the bytes, so a caller is told exactly what the number excludes. Summing their
parts is parked, with the cost reason recorded.

**Decisions (chosen on your behalf, flagged — see Open questions):**

- Bytes counted are `upload` and `copy` versions only, including OLD versions,
  because B2 bills for every version retained.
- `bucketName` is optional. Omitted means every bucket, which is what makes the
  Overview's question answerable in one call.
- The budget is a code constant, defaulting to 10 GiB — B2's free storage tier,
  so the default answers "am I about to start paying?"
- Scanning is page-capped, and a capped scan reports `truncated` rather than a
  short total presented as a whole one.

## Dependencies

None — reuses the existing stack.

## Goal of this feature

An AI client can ask which buckets are approaching or over their storage budget
and get real byte counts with an explicit statement of what was and was not
counted. It deliberately does NOT sum unfinished large-file parts, break usage
down by prefix, report bandwidth or transaction costs, or fetch B2 pricing.

## Design

### src/b2/usage.ts (new)

    DEFAULT_BUDGET_BYTES  = 10 * 1024 ** 3   // B2's free storage tier
    OVER_BUDGET_THRESHOLD = 0.8              // the Overview's "80%"
    PAGE_SIZE             = 1000
    MAX_PAGES_PER_BUCKET  = 20               // 20k versions, then stop and say so

    BucketUsage = { bucketName, bytesUsed, bytesUsedHuman, versionCount,
                    unfinishedLargeFiles, budgetBytes, percentOfBudget,
                    overThreshold, truncated }
    UsageReport = { buckets: BucketUsage[], totalBytesUsed, totalBytesUsedHuman,
                    anyTruncated }

    bucketUsage(client: UsageClient,
                options?: { bucketName?, budgetBytes?, thresholdPercent? })
      : Promise<UsageReport>

- Cites **Structural parameter types at module seams**, **Summary types at the
  MCP boundary**, and **Deterministic order is ours, not the API's** (CLAUDE.md
  > Established conventions). Buckets sort by bucketName.
- Reuses `BucketNotFoundError` from `src/b2/files.ts` when a named bucket is
  absent, so "no such bucket" never reads as "zero bytes used" — the same wrong
  answer 003 guarded against.
- The action filter is the core of the computation and gets its own named
  helper with the five actions spelled out, so a future reader can see at a
  glance which are counted and why.
- Page counting is manual around the iterator: the SDK's paginator hides paging,
  so the cap is enforced by tracking how many pages' worth of items have been
  consumed and breaking out. `truncated: true` when the cap stops a scan.
- `percentOfBudget` is rounded to one decimal. `bytesUsedHuman` renders GiB/MiB
  so an AI can answer in units a person reads, without the caller doing
  arithmetic on a raw byte count.
- Constants are POLICY and live in code, per CLAUDE.md > House rules. A caller
  may override budget and threshold per call; there is no environment variable,
  because a limit is not a secret and not machine-specific.

### src/server.ts (modified)

Registers `b2_bucket_usage`, following **Tool registration shape** (Established
conventions). `readOnlyHint: true`; the tool changes nothing.

zod input schema, all optional:

- `bucketName` — omit to scan every bucket
- `budgetBytes` — positive integer
- `thresholdPercent` — 1-100

The description states plainly that the figure EXCLUDES unfinished large-file
parts and that scanning costs one Class C transaction per 1000 versions per
bucket, so a client can decide whether to run it across a large account.

### tests/usage.test.ts (new)

A fake client yielding FileVersion-shaped records, built from the observed SDK
shape. Listing the cases exhaustively rather than by highlight: my predicted
counts have run short four slices in a row, always by omitting the dull ones.

- sums upload versions
- includes copy versions
- EXCLUDES hide markers
- EXCLUDES folder markers
- EXCLUDES start records, and reports them in unfinishedLargeFiles instead
- counts OLD versions of the same file name, since B2 bills for them
- versionCount reflects only the counted versions
- an empty bucket reports zero bytes and does not error
- percentOfBudget is computed against the default budget
- a caller-supplied budgetBytes overrides the default
- overThreshold is false just under the threshold
- overThreshold is true just over it
- a caller-supplied thresholdPercent overrides the default
- scanning every bucket returns one entry per bucket, sorted by name
- totalBytesUsed is the sum across buckets
- a named bucket scans only that bucket
- an unknown named bucket raises BucketNotFoundError
- hitting MAX_PAGES_PER_BUCKET sets truncated and stops iterating
- anyTruncated is true when any single bucket truncated
- bytesUsedHuman renders GiB and MiB sensibly
- an SDK rejection propagates

## Files

- src/b2/usage.ts — new; bucketUsage, BucketUsage, UsageReport, UsageClient,
  the four policy constants.
- src/server.ts — modified; register b2_bucket_usage.
- tests/usage.test.ts — new; the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Summing unfinished large-file PARTS into the byte total. Needs one
  paginateParts call per unfinished file; the count is reported instead.
- Usage broken down by prefix or virtual folder.
- Bandwidth, transaction counts, and anything cost-related in currency. B2
  publishes no pricing through this API and guessing at money is worse than
  silence.
- Caching a scan so repeat questions do not re-paginate.
- Per-bucket budgets configured individually rather than one budget applied to
  whichever bucket is being measured.

## Follow-ups after implementation

- Protected files — REQUIRED. Candidate: the cases asserting hide/folder/start
  are excluded. They are decoys whose removal would silently inflate every
  number the tool reports while the suite stays green. Assessed once passing.
- CLAUDE.md Commands — add a b2_bucket_usage smoke check and the cross-check
  against b2_list_files.
- CLAUDE.md Established conventions — nothing new expected; this slice reuses
  four. If 008 repeats the policy-constants-in-code shape, harvest it then.
- STATE.md and ROADMAP.md (007 to Done) — pre-approved, applied and reported.

## Open questions for you

1. **Is 10 GiB the right default budget?** It is B2's free storage tier, so the
   default answers "am I about to start paying?". If you would rather it mean
   something else, it is a one-constant change.
2. **Should a bucketless scan be allowed at all?** It is what makes the
   Overview's question work in one call, but on a large account it is the most
   expensive thing this server can do. The alternative is requiring a bucket
   name and making the AI loop. I recommend allowing it, with the cost stated
   in the tool description.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can answer "which buckets are over 80% of their budget?" with real
measured bytes, and is told when a scan was capped or when unfinished uploads
are excluded. Before this slice the server could list files but never total
them.

### Steps — confirm it by hand

1. `npm test` — expected: all pass, zero failures. Exact count confirmed against
   real output; any difference from the case list above is reported, not edited.
2. `npm run build` — expected: exits 0 silently, dist purged first.
3. Unknown bucket — `b2_bucket_usage --tool-arg bucketName=no-such-bucket-xyz`:
   expected `isError: true` naming the bucket, not a zero-byte report.
4. Real account, single bucket:
   `b2 b2_bucket_usage --tool-arg bucketName=felipe-prompt-gate`
   Expected: bytesUsed in the tens of MiB (that bucket holds roughly thirty PNGs
   near 1.2 MB each plus small JSON), a versionCount at least as large as the
   file count b2_list_files reports, percentOfBudget a small single-digit
   figure against the 10 GiB default, and truncated false.
5. All buckets: the same call with no arguments — expected one entry per bucket
   from b2_list_buckets, sorted by name, totalBytesUsed equal to their sum.
6. Real-data invariants, the checks that matter:
   - Cross-check with an existing tool: sum the contentLength values from
     `b2 b2_list_files --tool-arg bucketName=felipe-prompt-gate --tool-arg limit=1000`
     and compare against bytesUsed. The usage figure should be GREATER THAN OR
     EQUAL, never less: list_files shows only current versions while usage
     counts old ones too. A usage number BELOW the list_files sum means the
     action filter is wrong.
   - Compare against the Backblaze console's bucket size. Any gap should be
     explainable by unfinished large files, which the report names.

### VERIFIED — every step observed

1. `npm test` — 11 files, 114 tests, zero failures.
   DISCREPANCY, but a small one: this plan predicted 21 cases and the file has
   22. The extra came from splitting the human-readable case into a direct
   humanBytes test and a report-level one. Listing cases exhaustively rather
   than by highlight brought the error from four-slices-of-large-undercounts
   down to one.
2. `npm run build` — exit 0, dist purged first. tsc compiling server.ts is what
   proves the real B2Client and Bucket satisfy UsageClient and UsageBucket.
3. Unknown bucket returned "No bucket named no-such-bucket-xyz in this account"
   rather than a zero-byte report.
4/5. Real account: felipe-prompt-gate reported 24,184,275 bytes ("23.1 MiB"),
   versionCount 91, unfinishedLargeFiles 0, 0.2% of the 10 GiB default budget,
   overThreshold false, truncated false.
6. Real-data invariant, the check that mattered:
   - b2_list_files reported 90 CURRENT files summing to 24,184,247 bytes.
   - b2_bucket_usage reported 91 versions and 24,184,275 bytes.
   - usage >= list_files: PASS, by exactly 28 bytes and exactly one version.
   - The gap is explained precisely: delete-me.txt (28 bytes) was uploaded twice
     during plan 006's testing, so B2 holds two versions of it. list_files shows
     the current one; usage counts both. Old-version accounting is correct.
   - A number BELOW the list_files sum would have meant the action filter was
     wrong. It was not.

NOT verified against real data, and stated rather than implied: the account has
a single bucket, so the multi-bucket sort, totalBytesUsed across buckets, and
anyTruncated were exercised only by fixtures. The scan cap was likewise never
reached live -- 91 versions against a 20,000 cap.
