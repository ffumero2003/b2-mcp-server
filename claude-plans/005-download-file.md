# Plan 005 — download a file to a local path

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"005 - b2_download_file: download a file by name to a local path. Wraps
Bucket.download."

Plan 004 made the server read the local filesystem. This one makes it WRITE to
the local filesystem, which is the more dangerous direction: a bad destination
path does not leak a file, it destroys one.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do:

- `Bucket.download(fileName, options?): Promise<DownloadResult>` where
  `DownloadResult = { headers: DownloadHeaders, body: ReadableStream<Uint8Array> }`.
- `DownloadHeaders` carries contentType, contentLength, contentSha1 (null for
  large files), fileId, fileName, fileInfo, uploadTimestamp.
- **The SDK's own warning, quoted from dist/download/single.d.ts:** "If checksum
  verification fails, the stream errors after bytes have already flowed;
  discard any partially written output on ChecksumMismatchError."

That warning is the single biggest design driver in this slice. A naive
implementation that streams straight to the destination leaves a truncated,
corrupt file at exactly the path the caller now believes holds their data.

### Dependency on an unapproved rule

Plan 004 proposed a CLAUDE.md **Rule** for filesystem containment. It has NOT
been approved yet — `## Rules` is still `<empty until the project earns one>`,
and Established conventions still holds only the original three. So this plan
cannot cite that Rule; it points at `src/upload-path.ts` and plan 004 as the
precedent instead. If the Rule lands before implementation, the citation
replaces the description.

**Decisions (chosen on your behalf, flagged — see Open questions):**

- Downloads write only inside a configured root, denied by default, mirroring
  uploads but with its own variable.
- An existing destination file is NOT overwritten unless the caller opts in.
- The download is written atomically: temp file first, rename on success.

## Dependencies

None — reuses the existing stack. Node's `node:fs/promises` and
`node:stream` cover streaming and the atomic rename.

## Goal of this feature

An AI client can pull a named file out of a bucket onto local disk inside a
permitted directory, and is told what landed there. It deliberately does NOT
download ranges, whole prefixes, or non-current versions, does not return file
CONTENT as tool output, and does not decrypt SSE-C files.

## Design

### src/path-fence.ts (new — generalises src/upload-path.ts)

Plan 004 built the containment fence for reading. Writing needs the same fence
with two differences: the target need not exist yet, and its PARENT is what must
be contained and must exist. Rather than duplicating twenty lines of
security-critical comparison logic, 004's module is generalised:

    resolveExistingFile(candidate, rootVar, env) : Promise<string>   // read side
    resolveNewFilePath(candidate, rootVar, env)  : Promise<string>   // write side

- The containment comparison, realpath-before-compare, and the rule that a
  rejection message never names the root are lifted verbatim from
  `src/upload-path.ts`. This slice must not weaken them, and the existing
  12 cases move across unchanged to prove it.
- `resolveNewFilePath` realpaths the PARENT directory (which must exist) and
  checks containment on `join(realParent, basename)`. Realpathing a
  non-existent target would throw, and skipping the parent check would let
  `<root>/../evil/x.txt` through.
- Uses **Defaulted-collaborator parameter** (CLAUDE.md > Established
  conventions) for `env`.

### src/download-path.ts — NOT created

Deliberately named here as a rejected option so implementation does not invent
it: the write-side logic lives in `src/path-fence.ts`, not a parallel module.

### src/b2/download.ts (new)

    DownloadReceipt = { fileName, localPath, bucketName, contentLength,
                        contentType, fileId, sha1, downloadedAt }

    downloadFile(client: BucketDownloader,
                 options: { bucketName, fileName, localPath?, overwrite? },
                 resolvePath = ..., writeStream = ...)
      : Promise<DownloadReceipt>

- **Structural parameter types at module seams** (Established conventions):
  `BucketDownloader` is the narrow shape used here.
- Reuses `BucketNotFoundError` from `src/b2/files.ts`.
- `localPath` defaults to the file's basename inside the download root, so a B2
  object named `logs/2024/app.log` lands as `app.log` and cannot escape via its
  own stored name. A B2 file name is attacker-controlled data as far as this
  server is concerned.
- **Atomic write, driven by the SDK warning above.** The body streams to
  `<target>.<pid>.partial` in the same directory, then renames onto the target
  only after the stream completes cleanly. Same directory so the rename is a
  cheap atomic move rather than a cross-device copy. On ANY error the temp file
  is removed and the original target is left untouched.
- **Refuses to overwrite** an existing target unless `overwrite: true`, raising
  `DestinationExistsError`. Checked before the download starts, so a refused
  call costs no transfer.
- **Verifies the bytes written match `contentLength`** and raises
  `IncompleteDownloadError` on mismatch, deleting the temp file. This is the
  real-data invariant CLAUDE.md > Verification asks for, enforced in code rather
  than left to a fixture.
- Returns the receipt. **File CONTENT is never returned as tool output** — that
  would put an arbitrary file into the model's context.

### src/server.ts (modified)

Registers `b2_download_file`. zod input schema:

- `bucketName`: z.string().min(1) — required
- `fileName`: z.string().min(1) — required
- `localPath`: z.string().min(1).optional()
- `overwrite`: z.boolean().optional()

Annotations: `readOnlyHint: false`; `destructiveHint: true` — unlike upload,
this tool CAN destroy data, because `overwrite: true` replaces a local file and
a local file has no version history; `idempotentHint: true` — downloading the
same version twice to the same path yields the same bytes.

### tests/path-fence.test.ts (renamed from tests/upload-path.test.ts)

All 12 existing cases move across unchanged — the traversal escape, the
sibling-prefix directory, the symlink-out-of-root escape, and the assertion
that no message names the root. Plus, for the write side:

- a non-existent target inside the root resolves (it is about to be created)
- a target whose PARENT does not exist is rejected
- a target whose parent is a symlink pointing outside the root is rejected
- `<root>/../evil.txt` is rejected

### tests/download.test.ts (new)

Fake `BucketDownloader` yielding a small in-memory ReadableStream, with the temp
directory from `mkdtemp` as the root.

- writes the body to the target and returns the receipt
- defaults localPath to the basename, ignoring directories in the B2 file name
- refuses an existing target without `overwrite`, and the existing file is
  unchanged afterwards
- overwrites when `overwrite: true`
- a mid-stream error leaves NO partial file at the target and no temp file
- a byte count short of contentLength raises IncompleteDownloadError and writes
  nothing to the target
- unknown bucket raises BucketNotFoundError
- an SDK rejection propagates

## Files

- src/path-fence.ts — new; resolveExistingFile, resolveNewFilePath, and the
  containment logic moved from src/upload-path.ts.
- src/upload-path.ts — DELETED; its contents move to src/path-fence.ts.
- src/b2/upload.ts — modified; imports the fence from its new home.
- src/b2/download.ts — new; downloadFile, DownloadReceipt, BucketDownloader,
  DestinationExistsError, IncompleteDownloadError.
- src/server.ts — modified; register b2_download_file.
- tests/path-fence.test.ts — renamed from tests/upload-path.test.ts, all 12
  cases retained, 4 write-side cases added.
- tests/upload-path.test.ts — DELETED, replaced by the rename above.
- tests/upload.test.ts — modified; import path only.
- .env.example — modified; document B2_DOWNLOAD_ROOT.
- .gitignore — modified; add the uploads/ and downloads/ scratch directories.
- package.json — modified; the build script purges dist before compiling.
  ADDED AFTER THE FACT, with approval: this file was not in the original Files
  list. tsc leaves output for deleted sources, so dist/upload-path.js survived
  the deletion of src/upload-path.ts -- a stale copy of the OLD fence with no
  write-side logic. Recorded here as the plan gap it was rather than left as an
  undocumented implementation choice. Now also CLAUDE.md > What NOT to do.
  Caveat: `rm -rf` is not Windows-portable.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Range / partial downloads, and resuming an interrupted download.
- Downloading by fileId, or any non-current version.
- Bulk or prefix download.
- SSE-C decryption on download.
- A maximum download size guard. Worth revisiting: nothing currently stops a
  caller filling the disk.

## Follow-ups after implementation

- Protected files — REQUIRED. `tests/path-fence.test.ts` inherits the case for
  protection that `tests/upload-path.test.ts` had, and strengthens it: it is now
  the only coverage for BOTH the read and the write fence. Propose it.
- CLAUDE.md Rules — the containment Rule proposed by 004 is now used by two
  slices and two directions. Re-propose with the write side included.
- STATE.md and ROADMAP.md (005 to Done) — pre-approved, applied and reported.

## Open questions — ANSWERED

Both settled by the user; recorded here so the decision survives a /clear.

1. **Separate root.** `B2_DOWNLOAD_ROOT` is its own variable, so read access and
   write access are granted independently: a wide read directory with a narrow
   scratch write directory is a configuration this supports and a single shared
   root would not.
2. **The rename is approved.** src/upload-path.ts becomes src/path-fence.ts and
   tests/upload-path.test.ts becomes tests/path-fence.test.ts, with all 12 cases
   retained and 4 write-side cases added. The file is now listed in CLAUDE.md >
   Protected files, and that entry states the protection follows the file rather
   than the name.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can pull a file out of a bucket onto local disk, inside a permitted
directory, without ever risking a half-written file at the destination. Before
this slice the server could put files into B2 but never get them back out.

### Steps — confirm it by hand

1. `npm test` — expected: all pass, zero failures. The suite gains the download
   cases and the write-side fence cases while the 12 read-side cases move
   unchanged; the exact count is confirmed against real output and any
   difference from the case list above is reported, not edited to match.
2. `npm run build` — expected: exits 0 silently.
3. Refusal, no B2 call — call b2_download_file with `localPath` outside the
   root: expected `isError: true` naming the path, never the root.
4. Unconfigured — with `B2_DOWNLOAD_ROOT` unset: expected `isError: true`
   explaining the variable is not configured.
5. Round trip, REQUIRES the read-write key from 004 — upload a known file with
   b2_upload_file, then:
   `npx @modelcontextprotocol/inspector --cli npm run dev --method tools/call --tool-name b2_download_file --tool-arg bucketName=felipe-prompt-gate --tool-arg fileName=hello.txt`
   Expected: a receipt whose contentLength matches the original, and a local
   file whose bytes are identical to what was uploaded. This is why ROADMAP
   ordered upload before download.
6. Real-data invariant: `shasum` the original and the downloaded copy and
   compare, and confirm no `.partial` file is left in the root. Byte-identical
   round trip is the only proof that matters here.

### VERIFIED — all six steps observed

1. `npm test` — 8 files, 68 tests, zero failures.
   DISCREPANCY, recorded not hidden: this plan predicted the fence file would
   keep its 12 cases and add 4 (16 total) and that download would have 8.
   Actual: 20 fence cases (12 read-side unchanged, 8 write-side) and 10
   download cases. The extra write-side cases (existing file accepted so the
   overwrite decision stays with the caller, writing onto a directory,
   unconfigured root, and the root never appearing in a message) and the two
   extra download cases (no .partial left on success, an existing file
   surviving a mid-stream failure) were gaps in the plan's case list, not a
   miscount.
2. `npm run build` — exit 0.
   ISSUE FOUND: tsc does not delete output for removed sources, so
   dist/upload-path.js survived after src/upload-path.ts was deleted. Harmless
   at runtime because nothing imports it, but a stale copy of the OLD fence
   without write-side logic is exactly the sort of thing that gets imported by
   accident later. Purged by hand; a clean step for the build script is
   proposed rather than applied, since package.json was not in this plan's
   Files list.
3. Destination outside the root returned
   "Path is outside the permitted directory: /etc/evil.txt", root absent.
4. B2_DOWNLOAD_ROOT unset returned
   "Disabled: set B2_DOWNLOAD_ROOT to the directory this operation may use".
5. Round trip against the real account: downloaded hello.txt, contentLength 25,
   contentType text/plain, sha1 e8ffe076...3a6070, and the fileId IDENTICAL to
   the one plan 004's upload receipt reported.
6. Real-data invariant, three-way agreement:
   - shasum uploads/hello.txt   = e8ffe0764639709ed7f1856917c33fa2073a6070
   - shasum downloads/hello.txt = e8ffe0764639709ed7f1856917c33fa2073a6070
   - sha1 B2 reported           = e8ffe0764639709ed7f1856917c33fa2073a6070
   `cmp` reports the files identical, and no .partial file remained in the
   download directory. The bytes that left the disk are the bytes that came
   back.
