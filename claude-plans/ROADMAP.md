# Roadmap

The full parked list, across all plans. A plan's Out of scope section points
here instead of repeating it. Move an item to Done with the plan number that
shipped it; add new items as later plans park them. The moment a plan number
is assigned to an item — even before that plan's file exists — write it as
"00N - <description>", one line per number; a bundled item split across
several plans becomes that many lines.

## Planned — committed for this version

- 005 - b2_download_file: download a file by name to a local path. Wraps
  Bucket.download.
- 006 - b2_delete_file: delete a file version, and separately hide a file.
  Wraps Bucket.deleteFileVersion and Bucket.hideFile. The hide-vs-delete
  distinction is the whole design question: hide is reversible, delete is not.
- 007 - b2_bucket_usage: report bytes used per bucket by summing contentLength
  over file versions, and flag buckets above a configured percentage of a
  budget. This is what replaces "quota" -- B2's native API has NO quota, cap,
  or usage endpoint (verified against the full RawClient surface in
  dist/raw/index.d.ts; caps live only in the web console). The budget is
  project policy and lives in code, per CLAUDE.md House rules. Cost caveat:
  summing paginates every file version, a Class C transaction per page.
- 008 - b2_list_keys: list application keys with their capabilities and
  restrictions. Wraps B2Client.listKeys, whose response contains NO secrets.

## Possible — noted, not committed

- Application key CREATION and deletion. BLOCKER: B2Client.createKey returns
  FullApplicationKey.applicationKey -- the live secret, documented in the SDK
  as "only available in the b2_create_key response". As tool output that lands
  in the model's context window and the conversation transcript. Needs a design
  answer that keeps the secret out of tool output (write it to a gitignored
  file and return only the keyID?) before it can be Planned. (parked by 001,
  demoted from Planned when the return shape was checked)
- bucketId / bucketName / bucketTypes filters on b2_list_buckets. (parked by 001)
- Capability-gating tools with B2Client.hasCapabilities(), so a read-only key
  reports "this key cannot do that" instead of failing at the API boundary.
- Bucket lifecycle rules, replication, and notification rules. The SDK exposes
  all three on Bucket; none serve the Overview's stated purpose.
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