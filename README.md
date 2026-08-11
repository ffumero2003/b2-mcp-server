# b2-mcp-server

An MCP server that exposes Backblaze B2 Cloud Storage as tools any
MCP-compatible AI client can call. Manage B2 by talking to an assistant --
"which buckets are over 80% of their budget?", "upload this file", "delete that
version" -- instead of writing SDK code or clicking through the web console.

Nine tools over stdio: list buckets, list files, upload, download, hide, unhide,
delete a version, report bucket usage against a budget, and list application
keys.

Built on [@backblaze-labs/b2-sdk](https://www.npmjs.com/package/@backblaze-labs/b2-sdk)
and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Why it is shaped this way

The interesting part of an MCP server is not the API calls. It is what happens
when a language model is the one calling them.

- **Local filesystem access denies by default.** Upload reads only from
  `B2_UPLOAD_ROOT`, download writes only to `B2_DOWNLOAD_ROOT`, and both are
  refused outright when the root is unset. Read and write roots are separate so
  they can be granted independently. Paths are resolved with `realpath` before
  the containment check, so a symlink inside the root cannot point outside it,
  and containment is `target === root || target.startsWith(root + sep)` -- a
  bare `startsWith` would admit the sibling directory `/data/uploads-evil` for
  the root `/data/uploads`. Rejection messages name the offending path and never
  the root.
- **The one tool that destroys data cannot be aimed loosely.**
  `b2_delete_file_version` takes an exact `fileId` and refuses to resolve one
  from a file name, so "delete hello.txt" cannot be satisfied in a single step:
  the id has to come out of a listing a human can see. A confirm flag would not
  help, since the same model that calls the tool would set it. Deletion is also
  refused unless `B2_AUDIT_LOG` is configured, and writes an INTENT record
  before acting and an OUTCOME record after -- on failure too, because a log
  that can miss events is not a log. With `B2_ARCHIVE_ROOT` set, the bytes are
  copied locally first.
- **The credentials boundary enumerates its fields.** `b2_list_keys` names all
  nine fields it emits rather than spreading the SDK's key object, so a future
  SDK version that adds a secret-bearing field to a list response cannot leak it
  by accident. Key *creation* is deliberately not implemented for the same
  reason: B2 returns the live secret only from `createKey`, and that value would
  land in a model's context window.
- **Partial results announce themselves.** Anything that can return less than
  the whole truth says so in the payload -- `truncated`/`nextFileName` on file
  listings, `truncated`/`anyTruncated`/`unfinishedLargeFiles` on usage,
  `truncated` on key listings. A partial answer presented as a complete one is
  worse than a refusal, because the caller cannot tell.
- **Downloads are written atomically.** Bytes go to `<target>.<pid>.partial`,
  are counted and length-checked, and are renamed onto the target only on a
  match. The SDK documents that a checksum failure errors the stream *after*
  bytes have flowed, so writing straight to the final path would leave a
  truncated file behind.
- **Errors are returned, never thrown, across the MCP boundary.** A throw tears
  down the stdio session; an error result lets the client read the reason and
  explain it.

### On bucket usage

B2's API exposes no quota or usage endpoint -- caps and alerts live only in the
web console. `b2_bucket_usage` therefore sums file *versions*, including old
ones, because B2 bills for those too. Hide markers, folder markers, and start
records are excluded. Parts of unfinished large uploads are billed but not
summable, so they are reported separately as `unfinishedLargeFiles` and
`bytesUsed` is an honest floor rather than a total. The budget it is measured
against is project policy defined in code (10 GiB default, the B2 free tier),
not a B2 concept.

## Requirements

Node >= 22.3.0. This is a hard floor, not a preference -- the B2 SDK declares
it in `engines`. Pinned by `.nvmrc`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in .env; it is gitignored
npm test               # 131 passing
npm run build
```

Create an application key in the Backblaze console under **Account >
Application Keys**. Use a regular scoped key, not the master key: the master key
carries every capability, cannot be scoped, and cannot be deleted, only
regenerated.

### Environment

`.env.example` is committed documentation holding names only. Values go in
`.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `B2_APPLICATION_KEY_ID` | yes | Application key id. |
| `B2_APPLICATION_KEY` | yes | Application key secret. |
| `B2_UPLOAD_ROOT` | for uploads | The only directory `b2_upload_file` may read from. Unset means every upload is refused. |
| `B2_DOWNLOAD_ROOT` | for downloads | The only directory `b2_download_file` may write to. Unset means every download is refused. |
| `B2_AUDIT_LOG` | for deletion | Append-only JSON Lines file, one object per mutation. Deletion is refused when unset. |
| `B2_ARCHIVE_ROOT` | optional | Where a copy of each deleted version is kept before it is destroyed. A manifest proves what existed; this keeps the bytes. |

Capabilities needed per tool: `listBuckets`/`listFiles` for the read tools,
`writeFiles` for upload, `readFiles` for download, `deleteFiles` for deletion,
`listKeys` for `b2_list_keys`. A Read Only key fails at the B2 API on any write,
by design.

## Running

```bash
npm start     # node dist/server.js  (built)
npm run dev   # tsx src/server.ts    (from source)
```

The server speaks MCP over stdio. Nothing is ever written to stdout except the
protocol stream; diagnostics go to stderr.

### Wiring it into a client

Add to your MCP client config (Claude Desktop, Claude Code, or any other MCP
host):

```json
{
  "mcpServers": {
    "b2": {
      "command": "node",
      "args": ["/absolute/path/to/b2-mcp-server/dist/server.js"]
    }
  }
}
```

Credentials come from the `.env` file next to the package, so none appear in
client config.

### Calling tools by hand

```bash
npx @modelcontextprotocol/inspector --cli npm run dev --method tools/list

npx @modelcontextprotocol/inspector --cli npm run dev \
  --method tools/call --tool-name b2_bucket_usage
```

Each argument needs its own `--tool-arg`, for example
`--tool-arg bucketName=my-bucket`.

Gotcha worth knowing: a relative `localPath` resolves against the configured
root, not your shell's working directory. With `B2_UPLOAD_ROOT=".../uploads"`,
pass `localPath=hello.txt`, not `localPath=uploads/hello.txt` -- the latter
looks for `uploads/uploads/hello.txt`. The error message shows the candidate as
you gave it and deliberately not the resolved path, because that would print the
root.

## Tools

| Tool | Read/write | What it does |
| --- | --- | --- |
| `b2_list_buckets` | read | Every bucket, with id, name, and type. |
| `b2_list_files` | read | One page of current files in a bucket, optional `prefix` and `limit`, with `truncated`/`nextFileName`. |
| `b2_upload_file` | write | Uploads from `B2_UPLOAD_ROOT` into a bucket. Adds a version rather than replacing. |
| `b2_download_file` | write (local) | Downloads to `B2_DOWNLOAD_ROOT`, atomically. Returns the path and SHA-1, never the content. Will not replace an existing file unless `overwrite` is true. |
| `b2_hide_file` | write | Hides a file from listings. Reversible; the data stays in version history. |
| `b2_unhide_file` | write | Removes the latest hide marker. Reports `restored: false` rather than failing when nothing was hidden. |
| `b2_delete_file_version` | destructive | Permanently destroys one version. Needs the exact `fileId`, requires `B2_AUDIT_LOG`, honours `B2_ARCHIVE_ROOT`. |
| `b2_bucket_usage` | read | Bytes stored per bucket against a budget, flagging buckets over the threshold. Omit `bucketName` to scan every bucket. |
| `b2_list_keys` | read | Application keys with capabilities, bucket restrictions resolved to names, and derived expiry. No secrets. |

Every tool carries a zod input schema with per-field descriptions and MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) set honestly,
so a client can decide what needs confirmation.

## Testing

```bash
npm test
```

131 tests across 12 files, no network and no credentials required -- modules
take the narrow structural type they actually use (`BucketLister`, not
`B2Client`), so a fake satisfies them while `tsc` still proves the real client
fits.

Several test files are regression coverage for bugs that a green suite would not
otherwise catch, and their fixtures are shaped from *observed* dependency
behavior rather than from what the API ought to do:

- The B2 SDK throws errors with an **empty** `.message`; the diagnosis lives on
  `name`/`code`/`status`. Reading `.message` alone returned a blank string to
  the user for every B2-side failure.
- Node's `process.loadEnvFile()` reports an **unreadable** file as `ENOENT`, not
  `EACCES`, which downgrades "your .env has wrong permissions" to "you have no
  .env".

Where an invariant can be checked against real data instead of a fixture, it
was: usage was validated against a live account by the property that
`b2_bucket_usage` can never report fewer bytes than `b2_list_files` sums (it
exceeded it by exactly one 28-byte old version), and the delete path by a
four-way SHA-1 match across the original, the download, the archive copy, and
B2's own checksum. A fixture agrees with whatever the code does; a real corpus
does not.

## Project layout

```
src/
  server.ts        MCP server, tool registration
  config.ts        credentials from the environment
  env-file.ts      .env loading (Node built-in, zero dependencies)
  path-fence.ts    read and write containment, both directions
  atomic-write.ts  temp file plus rename
  audit-log.ts     append-only JSON Lines mutation record
  b2/              client, buckets, files, upload, download, delete, usage, keys
tests/             vitest, one file per module
claude-plans/      numbered design docs, written before the code
```

## Roadmap

The full parked list lives in `claude-plans/ROADMAP.md`. The largest known gap:
`b2_list_file_versions`. Usage counts every version the account is billed for
while `b2_list_files` shows only current ones, so the server can report "you are
paying for 91 versions across 90 files" and offer no way to see the difference.
Deleting a current version promotes the next-oldest, which makes discovery
destructive-only today.

## License

MIT.
