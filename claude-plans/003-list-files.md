# Plan 003 — list files in a bucket

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"003 - b2_list_files: list file names in a bucket, with optional prefix and
result limit. Wraps Bucket.listFileNames. Read-only."

This is the first slice whose tool takes ARGUMENTS. Plans 001 and 002 registered
a tool with an empty input schema; this one needs a required bucket name plus
two optional filters, so zod validation at the MCP boundary becomes real for the
first time.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do:

- `B2Client.getBucket(bucketName)` returns `Bucket | null`. Null is the
  not-found signal, not a throw.
- `Bucket.listFileNames({ prefix?, pageSize?, startFileName?, delimiter? })`
  returns `ListFileNamesResponse = { files: readonly FileVersion[],
  nextFileName: string | null }` — ONE page, not everything.
- `FileVersion` carries fileName, fileId, contentLength, contentType, and
  uploadTimestamp (epoch milliseconds), among other fields.
- `pageSize` is documented as 1-10000.

**Decisions (chosen on your behalf, flagged so they can be revisited):**

- One page per call, never auto-paginate. Walking a large bucket burns a Class C
  transaction per page and could return tens of thousands of records into a
  context window.
- No silent truncation. The result carries `truncated` and `nextFileName` so the
  model can say there is more, rather than implying it saw everything.
- Limits are policy, so they live in code (CLAUDE.md > House rules): default
  100, maximum 1000. The 1000 cap sits well under B2's 10000 because the real
  constraint is response size in a context window, not the API.
- uploadTimestamp is converted to an ISO 8601 string. Epoch milliseconds are
  unreadable in an AI's answer.
- delimiter / virtual-folder grouping is NOT exposed this slice.

## Dependencies

None — reuses the existing stack.

## Goal of this feature

An AI client can ask what is inside a bucket and get back a page of file names
with sizes, types, and upload times, optionally filtered by prefix. It
deliberately does NOT upload, download, delete, list non-current versions, or
walk past one page.

## Design

### src/b2/files.ts (new)

    FileSummary = { fileName, fileId, contentLength, contentType, uploadedAt }
    FileListing = { files: FileSummary[], truncated: boolean,
                    nextFileName: string | null }

    listFiles(client: BucketFinder,
              options: { bucketName: string, prefix?: string, limit?: number })
      : Promise<FileListing>

- Follows Structural parameter types at module seams (CLAUDE.md > Established
  conventions). `BucketFinder`, and the `FileLister` it returns, are the narrow
  shapes this module actually uses.
- `getBucket()` returning null raises `BucketNotFoundError` naming the bucket.
  Null would otherwise surface as an empty file list, which reads as "the bucket
  is empty" — a wrong answer rather than an error.
- `limit` is clamped into [1, MAX_LIMIT] and defaults to DEFAULT_LIMIT, both
  module constants. A caller asking for 5000 gets 1000, not an API error.
- Sorted explicitly by fileName, matching listBuckets in src/b2/buckets.ts. B2
  does appear to return lexicographic order, but CLAUDE.md > What NOT to do
  forbids relying on a dependency's unverified behavior; one localeCompare costs
  nothing and makes the ordering ours.
- `truncated` is `nextFileName !== null`, taken from the SDK response rather
  than inferred from `files.length === limit`, which is wrong whenever a page
  lands exactly on the limit.
- Errors from the SDK propagate; the server layer converts them.

### src/server.ts (modified)

Registers `b2_list_files` alongside `b2_list_buckets`, following Error results,
never throws, across the MCP boundary (CLAUDE.md > Established conventions).

zod input schema:

- bucketName: z.string().min(1) — required
- prefix: z.string().optional()
- limit: z.number().int().min(1).max(1000).optional()

The zod bound and the in-code clamp are deliberately redundant: zod rejects a
bad value at the protocol edge with a useful message, and the clamp keeps
listFiles correct for any non-MCP caller.

Handler chains loadConfig -> getClient -> listFiles and returns the listing as
pretty JSON.

### tests/files.test.ts (new)

A fake BucketFinder returning FileVersion-shaped objects, built from the
observed SDK shape rather than an assumed one.

- maps exactly the five summary fields, dropping everything else
- sorts by fileName given unsorted input
- converts uploadTimestamp (epoch ms) to an ISO 8601 string
- forwards prefix to the SDK unchanged
- applies DEFAULT_LIMIT when limit is omitted
- clamps a limit above MAX_LIMIT down to MAX_LIMIT
- truncated is true when nextFileName is non-null
- truncated is false when nextFileName is null, even if files.length === limit
- unknown bucket (getBucket -> null) throws BucketNotFoundError naming it
- empty bucket returns [] with truncated false
- an SDK rejection propagates

## Files

- src/b2/files.ts — new; listFiles, FileSummary, FileListing, FileLister,
  BucketFinder, BucketNotFoundError, DEFAULT_LIMIT, MAX_LIMIT.
- src/server.ts — modified; register b2_list_files.
- tests/files.test.ts — new; the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Auto-pagination, or a "list everything" mode that follows nextFileName.
- delimiter support for virtual-folder grouping.
- Listing non-current file versions (that is listFileVersions, not this tool).

## Follow-ups after implementation

- Protected files — REQUIRED. Assessed after tests pass: tests/files.test.ts
  qualifies ONLY if it becomes the sole regression coverage for a bug found
  during this slice. If nothing breaks, no entry. Answered either way.
- CLAUDE.md Commands — the expected test count changes from 19. Propose the
  exact edit; CLAUDE.md is protected.
- Established conventions — tool registration shape (zod schema + handler + JSON
  text result) is now used twice. Propose harvesting it on the THIRD use, not
  this one.
- STATE.md and ROADMAP.md (move 003 to Done) — pre-approved, applied and
  reported.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can list what is inside a bucket, filtered by prefix, and is told
when it is only seeing part of the contents. Before this slice the server could
name buckets but never look inside one.

### Steps — confirm it by hand

1. `npm test` — expected: `Test Files 5 passed (5)`, `Tests 30 passed (30)`
   (19 existing plus 11 new). The real count is confirmed against actual output
   before the slice is reported; a mismatch is reported as a discrepancy, not
   edited to match.
2. `npm run build` — expected: exits 0 silently.
3. Smoke check, happy path, against a real bucket:
   `npx @modelcontextprotocol/inspector --cli npm run dev --method tools/call --tool-name b2_list_files --tool-arg bucketName=felipe-prompt-gate`
   Expected: JSON with `files`, each having exactly fileName, fileId,
   contentLength, contentType and uploadedAt, sorted by fileName, plus
   `truncated` and `nextFileName`. An empty bucket gives `files: []` and
   `truncated: false`.
4. Error path: the same command with `bucketName=no-such-bucket-xyz` —
   expected: `isError: true` and a message naming no-such-bucket-xyz.
5. Real-data invariant: compare the file names and count against the Backblaze
   console for that bucket. A fixture-only pass proves the mapper is
   self-consistent, not that it reflects the real bucket.
