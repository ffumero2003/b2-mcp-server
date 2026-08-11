# Roadmap

The full parked list, across all plans. A plan's Out of scope section points
here instead of repeating it. Move an item to Done with the plan number that
shipped it; add new items as later plans park them. The moment a plan number
is assigned to an item — even before that plan's file exists — write it as
"00N - <description>", one line per number; a bundled item split across
several plans becomes that many lines.

## Planned — committed for this version

EMPTY. Every committed item has shipped, which is this project's definition of
done (CLAUDE.md > Workflow conventions). Items below in Possible never block it.

## Possible — noted, not committed

Grouped by kind so a future session can pick sensibly. Nothing here blocks done.

### Completes what shipped — gaps the finished product reveals

- b2_list_file_versions: list ALL versions of a file, not just current ones.
  THE REAL HOLE IN v1, found by using the product rather than reading it.
  b2_bucket_usage counts every version the account is billed for, and
  b2_list_files (listFileNames) shows only current ones, so the tool can say
  "you are paying for 91 versions across 90 files" and offer no way to see the
  difference. Worse, verified empirically during close-out: deleting a current
  version PROMOTES the next-oldest to current, so old versions are reachable
  only by destroying the newer ones. Discovery is currently destructive-only.
  The SDK already has what a fix needs -- Bucket.listFileVersions and
  paginateFileVersions, both already used by src/b2/usage.ts.
- Deleting all versions of a name in one call. Depends on the above: you cannot
  safely delete what you cannot enumerate. Bucket.deleteAll and deleteMany
  exist in the SDK.

### Small polish — cheap, self-contained

- bucketId / bucketName / bucketTypes filters on b2_list_buckets. (parked by 001)
- Generalise the capability pre-check. 008 used B2Client.hasCapabilities() for
  b2_list_keys alone; applying it across all nine tools would turn every
  permission failure into "this key cannot do that" instead of a B2 error.

### New capability — real features, real design work

- Application key CREATION and deletion. BLOCKER: B2Client.createKey returns
  FullApplicationKey.applicationKey -- the live secret, documented in the SDK
  as "only available in the b2_create_key response". As tool output that lands
  in the model's context window and the conversation transcript. Needs a design
  answer that keeps the secret out of tool output (write it to a gitignored
  file and return only the keyID?) before it can be Planned. CLAUDE.md > Rules
  now carries the constraint any such design must satisfy: a boundary where a
  secret could appear enumerates its fields and never spreads a third-party
  object. (parked by 001, demoted from Planned when the return shape was checked)
- Bucket lifecycle rules, replication, and notification rules. The SDK exposes
  all three on Bucket; none serve the Overview's stated purpose.

### Changes the deployment model — biggest, least certain

- HTTP/SSE transport alongside stdio. (parked by 001)
- Named credential profiles, for one operator with several B2 accounts. Tools
  would take a profile NAME, never a secret. (parked by 001)
- Runtime credential prompting via MCP elicitation (server.elicitInput(),
  confirmed present in @modelcontextprotocol/sdk 1.30.0, form and url modes).
  Caveat: elicitation form fields are plain string/number/boolean/enum with no
  secret type, and client support is uneven. (parked by 001)
- Hosted HTTP transport with OAuth 2.1 for true multi-tenancy. The SDK ships a
  full authorization server under server/auth/. BLOCKER: B2 has no OAuth flow
  for application keys, so this means a custom auth layer plus custody of other
  people's credentials, and it is the only option with a recurring hosting
  bill. (parked by 001)

## Done

- List buckets over MCP: stdio server exposing b2_list_buckets. (001)
- .env file loading. (002) Landed with ZERO dependencies: Node 22's built-in
  process.loadEnvFile replaced the planned dotenv package.
- b2_list_files: one page of current files in a bucket, optional prefix and
  limit, with truncated/nextFileName so partial results are never silent. (003)
- b2_upload_file: first write tool. Local reads are confined to B2_UPLOAD_ROOT,
  denied by default, with realpath resolution before the containment check.
  (004)
- b2_list_keys. (008) THE LAST PLANNED ITEM. Lists keys with capabilities,
  bucket restrictions resolved from ids to NAMES, and derived expiry. The
  mapper enumerates all nine emitted fields rather than spreading the SDK
  object, so a future SDK adding a secret to the list response cannot leak it.
  Verified against real B2 output: no bare applicationKey field, no deprecated
  bucketId. A narrow use of hasCapabilities() gives a legible refusal when a
  key lacks listKeys -- though the current key HAS it, so that path is untested
  against a real refusal.
- b2_bucket_usage. (007) Answers the Overview's headline question, which B2
  itself cannot: there is no usage endpoint, so bytes are summed from file
  versions, INCLUDING old ones since B2 bills for them. hide, folder and start
  records are excluded; unfinished large uploads are COUNTED but their parts
  are not summed, so bytesUsed is an honest floor rather than a total. Verified
  against the real account by an invariant a fixture cannot check: usage
  (24,184,275 bytes over 91 versions) exceeded the b2_list_files sum
  (24,184,247 over 90 current files) by exactly one 28-byte old version.
- b2_hide_file, b2_unhide_file, b2_delete_file_version. (006) Shipped WIDER
  than the roadmap line, with approval: unhide was added because hide is only
  reversible if something reverses it, and deletion gained a mandatory
  append-only audit log plus optional archiving. Deletion requires the exact
  fileId and is refused unless B2_AUDIT_LOG is set. Verified by a four-way
  SHA-1 match across original, download, archive, and B2's own checksum.
- b2_download_file. (005) The fence generalised to cover local WRITES
  (B2_DOWNLOAD_ROOT, separate from the read root). Written atomically via a
  temp file and rename, because the SDK documents that a checksum failure
  errors the stream after bytes have flowed. Verified by a byte-identical
  round trip: upload and download SHA-1s match B2's own.