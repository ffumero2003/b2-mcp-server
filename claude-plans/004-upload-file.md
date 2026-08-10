# Plan 004 — upload a local file to a bucket

## Context

Current state: see claude-plans/STATE.md. ROADMAP.md assigns this slice:
"004 - b2_upload_file: upload a local file to a bucket. Wraps Bucket.upload.
Ordered before download so 005 can verify against a file this project put there
itself."

This is the project's FIRST WRITE tool. Everything shipped so far is read-only,
so two things are new and neither is incidental:

1. The tool reads the LOCAL filesystem at a path the model supplies.
2. The tool needs a B2 key capability the current credentials do not have.

Verified against the SDK's own .d.ts before planning, per CLAUDE.md > What NOT
to do:

- `Bucket.upload(options: BucketUploadOptions): Promise<FileVersion>` where
  BucketUploadOptions is `{ fileName, source: ContentSource, contentType?,
  fileInfo?, ... }`. It automatically switches to multipart for large files, so
  this slice does not have to.
- `contentType` defaults to `"b2/x-auto"`, meaning B2 detects it. Omitting the
  field is better than guessing a MIME type locally.
- `FileSource.fromPath(path): Promise<FileSource>` is the local-file source.
  Its constructor is documented to throw if the path "does not reference a
  regular non-symlink file" — a useful second line of defence, not the first.
- `Capability.WriteFiles` ("writeFiles") is what B2 requires for upload, and
  `B2Client.hasCapabilities()` can test for it.

### Blocker you must clear before the smoke check

The application key currently in `.env` was created **Read Only** on my advice
in plan 001. Read Only does not include `writeFiles`, so this tool will fail
against B2 with a capability error until a read-write key exists. That is
correct behaviour, not a bug. Verification step 5 below cannot pass without a
new key, and the plan says so rather than discovering it at the end.

**Decisions (chosen on your behalf, flagged — see Open questions):**

- Uploads are confined to a configured root directory. Deny by default.
- Overwrite is allowed and is not destructive: B2 keeps versions, so uploading
  an existing name adds a version rather than replacing data.

## Dependencies

None — reuses the existing stack.

## Goal of this feature

An AI client can upload a named local file into a bucket and get back the
resulting file's identity and size. It deliberately does NOT download, delete,
sync directories, upload from a URL, or accept raw file content as a tool
argument.

## Design

### src/upload-path.ts (new)

    UPLOAD_ROOT_VAR = 'B2_UPLOAD_ROOT'
    resolveUploadPath(candidate: string, env = process.env): Promise<string>

The security boundary of this slice, and the reason it is its own module rather
than a few lines inside the B2 code: it is filesystem policy, not B2 logic, and
it deserves its own tests.

- Uses the **Defaulted-collaborator parameter** convention (CLAUDE.md >
  Established conventions) for `env`.
- If `B2_UPLOAD_ROOT` is unset, throws `UploadRootNotConfiguredError`. **Deny by
  default**: a server that will happily read any path the model names is an
  exfiltration primitive, and this project has already had one credential
  incident. Opting in is one line in `.env`; opting out of a breach is not.
- Resolves BOTH the root and the candidate with `fs.realpath` before comparing,
  so a symlink inside the root pointing at `~/.ssh` does not escape. Comparing
  unresolved strings is the classic hole here.
- Containment is checked as `resolved === root || resolved.startsWith(root +
  path.sep)`, never bare `startsWith(root)` — otherwise `/data/uploads-evil`
  passes for root `/data/uploads`.
- Rejects anything that is not a regular file, with `PathNotAllowedError` naming
  the offending path but never printing the root (which would tell a caller
  exactly where the fence is).

### src/b2/upload.ts (new)

    UploadReceipt = { fileId, fileName, bucketName, contentLength, contentType,
                      uploadedAt }
    uploadFile(client: BucketUploader,
               options: { bucketName, localPath, fileName?, contentType? })
      : Promise<UploadReceipt>

- **Structural parameter types at module seams** (Established conventions):
  `BucketUploader` is the narrow shape used here.
- REFINED AT IMPLEMENTATION TIME: `resolvePath` and `createSource` are also
  defaulted collaborators, so tests exercise this module without a real disk or
  a real FileSource. This applies the existing Defaulted-collaborator parameter
  convention; it changes the signature the Design section sketched, and is
  recorded here rather than left as an undocumented implementation choice.
- Reuses `BucketNotFoundError` from `src/b2/files.ts` rather than defining a
  second one; a missing bucket must not read as a failed upload.
- `fileName` defaults to the basename of `localPath`. Uploading
  `/home/me/report.pdf` should not create a B2 object literally named
  `/home/me/report.pdf`.
- `contentType` is forwarded only when supplied, so B2's `b2/x-auto` detection
  stays the default rather than being overridden by a guess.
- Calls `resolveUploadPath` first and passes the RESOLVED path to
  `FileSource.fromPath`, so the checked path and the read path are the same one.
  Re-resolving inside the SDK would be a time-of-check/time-of-use gap.
- Maps the returned `FileVersion` to a receipt, with `uploadTimestamp` converted
  to ISO 8601, matching how `src/b2/files.ts` already presents times.

### src/server.ts (modified)

Registers `b2_upload_file`, following **Error results, never throws, across the
MCP boundary** (Established conventions).

zod input schema:

- `bucketName`: z.string().min(1) — required
- `localPath`: z.string().min(1) — required
- `fileName`: z.string().min(1).optional()
- `contentType`: z.string().min(1).optional()

Annotations differ from every previous tool and the difference is the point:

- `readOnlyHint: false` — it writes.
- `destructiveHint: false` — B2 versions rather than overwrites, so an existing
  file is not destroyed. 006 is the slice that gets `destructiveHint: true`.
- `idempotentHint: false` — calling twice creates two versions.

### tests/upload-path.test.ts (new)

Uses `mkdtemp` for a real temp root, as `tests/env-file.test.ts` does, so no
fixture path is ever committed.

- a file directly inside the root resolves
- a file in a nested subdirectory resolves
- `../escape.txt` is rejected
- an absolute path outside the root is rejected
- a sibling root sharing a name prefix (`<root>-evil/x`) is rejected
- a symlink inside the root pointing outside is rejected after realpath
- a directory is rejected
- unset `B2_UPLOAD_ROOT` throws UploadRootNotConfiguredError
- the error message never contains the root path

### tests/upload.test.ts (new)

Fake `BucketUploader` returning a FileVersion-shaped object, built from the
observed SDK shape.

- returns exactly the receipt fields
- defaults fileName to the basename of localPath
- an explicit fileName overrides the basename
- contentType is omitted from the SDK call when not supplied
- contentType is forwarded when supplied
- unknown bucket throws BucketNotFoundError naming it
- an SDK rejection propagates

## Files

- src/upload-path.ts — new; resolveUploadPath, UPLOAD_ROOT_VAR,
  UploadRootNotConfiguredError, PathNotAllowedError.
- src/b2/upload.ts — new; uploadFile, UploadReceipt, BucketUploader.
- src/server.ts — modified; register b2_upload_file.
- tests/upload-path.test.ts — new; the cases above.
- tests/upload.test.ts — new; the cases above.
- .env.example — modified; document B2_UPLOAD_ROOT as an optional name, no value.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- Uploading raw content passed as a tool argument rather than a file path.
- Directory / recursive upload and sync.
- Progress reporting via onProgress, and upload resume.
- Server-side encryption, retention, and legal hold on upload.
- Multiple upload roots, or per-bucket root rules.

## Follow-ups after implementation

- Protected files — REQUIRED. `tests/upload-path.test.ts` is the strongest
  candidate this project has produced: its symlink and prefix-sibling cases are
  exactly the decoys whose removal would leave a green suite and an escapable
  fence. Assess against the criteria once it passes; if it qualifies, appending
  is pre-approved and gets reported.
- Established conventions — tool registration (zod schema + handler + JSON text
  result) reaches its THIRD use here, which is the threshold plan 003 set.
  Propose harvesting it.
- CLAUDE.md Commands — test count changes again. NOTE: the count has now churned
  on every slice; propose either the new number or the churn-proof wording
  already offered.
- CLAUDE.md Rules — likely earns the project's first: "a tool that reads the
  local filesystem confines paths to a configured root, resolved with realpath
  before comparison." Propose it.
- STATE.md and ROADMAP.md (004 to Done) — pre-approved, applied and reported.

## Open questions for you

1. **Deny by default?** As designed, `b2_upload_file` fails until
   `B2_UPLOAD_ROOT` is set. The alternative is defaulting to some directory,
   which is friendlier and weaker. I recommend deny.
2. **Does an upload root belong in `.env`?** CLAUDE.md > House rules says policy
   lives in code, not `.env`. A root path is machine-specific rather than
   policy, and it is not a secret — so I read this as compatible, with the
   *rule* (paths must be contained) living in code and only the location in the
   environment. Flagging it because it brushes against a House rule and that is
   your call, not mine.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

An AI client can put a local file into a B2 bucket and is told the resulting
file's id, name, and size. Before this slice the server could only read.

### Steps — confirm it by hand

1. `npm test` — expected: `Test Files 7 passed (7)`, `Tests 50 passed (50)`
   (30 existing plus 20 new).
   DISCREPANCY, recorded not hidden: this plan first predicted 46, from 9
   path cases plus 7 upload cases. Implementation wrote 12 and 8. The four
   extra path cases (relative-path resolution, a non-existent path, an
   unusable root, and the root never appearing in a rejection message) and
   one extra upload case (a forbidden path costing no upload call) were gaps
   in the plan's case list, not a miscount. File count was predicted
   correctly.
2. `npm run build` — expected: exits 0 silently.
3. Refusal path, no B2 call and no key needed — call b2_upload_file with
   `localPath` set to a path outside the root, e.g. `/etc/hosts`:
   expected `isError: true` naming the rejected path, and NOT naming the root.
4. Unconfigured path — with `B2_UPLOAD_ROOT` unset, any upload attempt:
   expected `isError: true` explaining the variable is not configured.
5. Happy path, REQUIRES a read-write key (see Blocker above). Create a small
   file inside the root, then:
   `npx @modelcontextprotocol/inspector --cli npm run dev --method tools/call --tool-name b2_upload_file --tool-arg bucketName=felipe-prompt-gate --tool-arg localPath=<root>/hello.txt`
   Expected: JSON receipt with fileId, fileName `hello.txt`, contentLength
   matching the local file's byte count, and an ISO uploadedAt.
6. Real-data invariant: run `b2_list_files` for that bucket and confirm
   `hello.txt` appears with the same contentLength, then confirm it in the
   Backblaze console. Two tools agreeing is better evidence than either alone.

Steps 1-4 I can run. Steps 5 and 6 need a read-write key and your bucket; I will
report exactly which I observed rather than implying all passed.
