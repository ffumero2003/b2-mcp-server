# Plan 011 — human-confirmed deletion

## Context

Current state: see claude-plans/STATE.md.

006 shipped a rule, now in CLAUDE.md > Rules and README.md — b2_delete_file_version
takes an exact fileId and never resolves one from a name, "so the id has to come
from a listing a human can see." src/b2/delete.ts:172-175 says the same in a doc
comment. A live demo through Claude Desktop disproved it.

What actually happened: the model called b2_list_files, read the fileId ITSELF,
presented a summary carrying name, size and date but NOT the fileId, the user
said "go ahead", and the model passed the id it had obtained on its own. The
delete succeeded, with a clean INTENT/OUTCOME pair and a correct archive copy.

The guard did exactly what its code says. What its code says was never what its
comment claimed. The claim was about a HUMAN seeing the id, and nothing enforced
that a human saw anything. A natural-language "go ahead" is functionally the
confirm flag CLAUDE.md > Rules already rejects: "the same model that calls the
tool would set it." Here the model both wrote the summary and judged the answer
to it.

The fix is a channel the model cannot speak on: MCP elicitation, where the
SERVER asks the CLIENT to ask the HUMAN, and the model is not in the path.

### The finding that shaped the design

The obvious implementation — form-mode elicitation, a native dialog — DOES NOT
WORK on the client this slice exists for. Claude Desktop declares:

    capabilities:{elicitation:{url:{}}}
    (/Applications/Claude.app/Contents/Resources/app.asar)

URL mode only. The SDK gates form mode on a different key:

```js
case 'form': {
    if (!this._clientCapabilities?.elicitation?.form) {
        throw new Error('Client does not support form elicitation.');
```
(node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:351-352)

and the preprocessor that rescues spec-2025-06-18 clients declaring a bare
`elicitation: {}` fires only on an EMPTY object (types.js:335-345), so
`{url:{}}` is not normalised and `elicitation.form` is undefined. A form-mode
design would have thrown on every delete in Claude Desktop — failing closed
100% of the time, in the exact client where the bug was found.

This is the fourth instance of this project's most-repeated scar. The first
three were the shape of a dependency's ERRORS (001), its PERMISSIONS (009), and
how it SPAWNS A PROCESS (the inspector). This one is the shape of what the OTHER
END OF THE WIRE declares it can do. Reading the SDK correctly was not enough;
the SDK is not the client.

**Decisions (confirmed with the user):**

- Support BOTH modes, selected from the client's declared capability. Form when
  offered, URL otherwise, refuse when neither. Form-capable clients get a native
  dialog and no listener at all.
- URL mode serves a one-shot page on 127.0.0.1, opened only while a confirmation
  is pending and closed the moment it is answered. A stdio server binding a port
  is a real cost and is scoped to the seconds it is needed.
- The prompt is built from B2's OWN metadata, read by getFileInfo, not from the
  caller's arguments. Showing the human the model's claims back would reproduce
  the exact failure one layer further in.
- FAIL CLOSED. A client that can do neither mode cannot delete, with no override
  in code, no tool argument, and no environment variable.
- A refusal is RECORDED, per "a log that can miss events is not a log."
- Deletion through the pinned inspector 0.15.0 CLI stops working, deliberately,
  and is replaced in Verification rather than worked around.

## Dependencies

None — reuses existing stack. Elicitation is already in
@modelcontextprotocol/sdk 1.30.0; the listener uses node:http and node:crypto.

## Goal of this feature

Before a version is destroyed, the server asks the human directly, through the
MCP client, showing the exact file id, the file name, the size and the SHA-1
that B2 reports for that id — and destroys nothing unless the human answers yes.
The model cannot answer for it. A client that cannot ask a human is refused
outright. Nothing else about a confirmed deletion changes, and no other tool is
affected.

## Design

### src/confirm.ts (new)

The confirmation channel, isolated from B2 and from the MCP wiring.

```
export interface Elicitor                     // the narrow SDK shape used
export interface DeletionPrompt               // what the human is shown
export type ConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; reason: 'declined' | 'cancelled' | 'unconfirmable'; detail?: string }
export type DeletionConfirmer = (details: DeletionPrompt, signal?: AbortSignal) => Promise<ConfirmationResult>

export const CONFIRMATION_TIMEOUT_MS = 180_000
export const CONFIRM_FIELD = 'confirm'
export function elicitDeletionConfirmation(elicitor: Elicitor): DeletionConfirmer
export const denyUnconfirmable: DeletionConfirmer
```

- Structural parameter types at module seams, per Established conventions.
  Elicitor declares only getClientCapabilities() and elicitInput(). The real
  Server satisfies it structurally, proved by tsc where server.ts passes one in.
  Verified: elicitInput lives on Server, NOT on McpServer, so the call site is
  `server.server.elicitInput` (dist/esm/server/index.d.ts:158).
- MODE SELECTION reads getClientCapabilities()?.elicitation and prefers form,
  falls back to url, refuses when neither is present. It does NOT re-implement
  the SDK's legacy normalisation: a bare `{}` is already rewritten to
  `{form:{}}` before the server stores it, so reading `.form` and `.url` is
  sufficient and a hand-written spec-derived check would wrongly refuse legacy
  clients.
- ANY failure of the channel is a refusal, never a pass. Capability absent,
  timeout, abort, malformed response, unexpected throw — every one returns
  confirmed:false. This is the module's single most important invariant and the
  reason it returns a result rather than throwing.
- FORM MODE requests one required enum field, `confirm`, values "yes" and "no",
  with NO `default`. The absence is load-bearing: the client capability object
  advertises `applyDefaults` (types.js:332-334), so a field carrying a default
  can be filled in with no human present. accept + "yes" is the ONLY
  confirmation; accept + "no", decline and cancel are all refusals.
- CONFIRMATION_TIMEOUT_MS is a policy constant in code, per Established
  conventions > Policy constants in code, and is passed EXPLICITLY as
  RequestOptions.timeout. It must be, because the SDK's default is 60000
  (shared/protocol.js:8) and a human in URL mode has to leave the client, read a
  browser page, and answer. Three minutes is the budget; the caller's
  AbortSignal is threaded through so a client cancellation ends the wait early
  (RequestOptions.signal "will cause an AbortError to be raised from request()",
  shared/protocol.d.ts:69-71).
- denyUnconfirmable exists so deleteFileVersion's collaborator can default to
  DENYING. An accepting default would let a future call site drop the guard in
  silence, which is the failure this whole slice is about.

### src/confirm-listener.ts (new)

The one-shot local page for URL mode. Its whole job is to be reachable by the
human's browser and by nothing else.

```
export interface PendingConfirmation { url: string; answered: Promise<boolean>; close(): void }
export const LISTENER_HOST = '127.0.0.1'
export async function openConfirmationPage(details: DeletionPrompt): Promise<PendingConfirmation>
```

- Binds LISTENER_HOST explicitly, never 0.0.0.0 — the page must not be reachable
  from the network, only from this machine's browser.
- Port 0, so the OS assigns an ephemeral port and nothing is reserved between
  deletions.
- The path carries a nonce from crypto.randomBytes(32), hex-encoded. Any request
  whose path does not match exactly gets 404 and does not answer the promise.
  127.0.0.1 is shared with every other local process and user, so the nonce, not
  the interface, is what makes the page private.
- GET renders the confirmation; POST to the same nonce path submits the answer.
  The nonce doubles as the CSRF token, since a third party cannot construct the
  path.
- Exactly ONE answer is accepted; the second request is refused and the server
  is already closing. Opened when a delete is pending and closed on answer,
  timeout, or abort — never left listening.
- The page states the same four facts as the form prompt, plus whether an
  archive copy will be kept.

### src/audit-log.ts (modified)

- AuditPhase gains 'refused'. AuditRecord.outcome gains 'declined', 'cancelled'
  and 'unconfirmable'.
- A refused record is a SINGLE line with no preceding intent, so it cannot be
  mistaken for either half of the delete pair. The existing invariant — intent
  then outcome, in that order, for every attempted destruction — is untouched,
  and `tail -2` still reads plainly.
- Recording the refusal is the point: a human declining a destruction is the
  most security-relevant line the file can hold, and under a prompt-injection
  attempt it is the only trace an operator would ever have.

### src/b2/delete.ts (modified)

deleteFileVersion gains a fourth defaulted-collaborator parameter, per
Established conventions:

```
deleteFileVersion(client, options, env = process.env, confirm = denyUnconfirmable)
```

New order, replacing the six steps in the existing doc comment:

```
1. audit log configured, or nothing happens at all      (unchanged, first)
2. confirmation channel available, or refuse            (NEW, before any B2 call)
3. read metadata -- after deletion it exists nowhere
4. ASK THE HUMAN, from that metadata                    (NEW)
5. archive if configured
6. write the intent record
7. delete
8. write the outcome record, success or failure
```

- Step 1 stays first so the audit-gate proof recorded in CLAUDE.md >
  Verification keeps working verbatim: withholding B2_AUDIT_LOG must still
  produce the audit refusal, not the confirmation one.
- Step 2 precedes requireBucket because capability is a property of the
  CONNECTION, not of the file. No metadata can change the answer, so no B2 call
  is spent finding out — the same property the existing gate has and that
  tests/delete.test.ts already asserts.
- Step 4 sits after step 3 because the whole defect is a model SUMMARISING a
  file for a human. The prompt shows meta.fileName, meta.contentLength,
  meta.contentSha1 and meta.uploadTimestamp — B2's answer for that id — so a
  human can catch an id that does not match the file it was described as.
  bucketName and fileId are shown as given, because they are the lookup keys.
- Step 4 sits before step 5 because archiving downloads the whole object to
  local disk. A refused deletion must not leave a local copy of data the human
  declined to touch, and a human must not wait behind a large download to be
  asked.
- A refusal writes one `phase: 'refused'` record and throws
  DeletionNotConfirmedError, whose message names the reason and, for
  'unconfirmable', names the remedy.
- The doc comment's claim that the id "has to come from b2_list_files, where a
  human can see which version is at stake" is REMOVED. It was never true and is
  the reason this slice exists.

### src/server.ts (modified)

- The b2_delete_file_version handler passes
  `elicitDeletionConfirmation(server.server)` as the fourth argument, threading
  the handler's `extra.signal` so a client cancellation aborts the question.
- The tool description states that the server asks the human directly and that a
  client which cannot ask is refused, so the model neither reports success early
  nor retries a refusal as a transient error.
- Errors keep flowing through Error results, never throws. The SDK's capability
  error carries a populated .message (server/index.js:351-352), unlike the B2
  family, so toMessage passes it through unchanged.

### tests/confirm.test.ts (new)

Against the LIVE SDK over InMemoryTransport.createLinkedPair(), plus fakes:

- A client declaring `{url:{}}` selects URL mode and NOT form. DECOY: this is the
  Claude Desktop shape, and a design that reads only `.elicitation` would pick
  form and throw on every delete in the one client that matters.
- A client declaring no elicitation capability gives confirmed:false /
  'unconfirmable' — not a hang and not a throw. DECOY: pins real SDK behavior.
- A client declaring a bare `{}` IS treated as form-capable, because the SDK
  preprocesses it to `{form:{}}`.
- accept + confirm "yes" is the only confirmation; accept + "no", decline and
  cancel are refusals with the matching reason.
- An elicitor that throws is a refusal, not a pass.
- The form schema carries NO `default` on the confirm field. DECOY: nothing else
  fails if one is added, and a client honouring applyDefaults would confirm
  deletions with no human present.
- CONFIRMATION_TIMEOUT_MS is passed explicitly to elicitInput, not left to the
  SDK default.

### tests/confirm-listener.test.ts (new)

- The page binds 127.0.0.1 and not 0.0.0.0. DECOY: the assertion is one string,
  and its absence exposes a delete-confirmation page to the local network.
- A request to a WRONG nonce path is 404 and does not answer the pending
  promise. DECOY: without it the page can be answered by anything that finds the
  port.
- A second POST after an answer does not produce a second answer.
- close() releases the port, asserted by binding again.

### tests/delete.test.ts (modified, PROTECTED)

Every existing deleteFileVersion case gains an accepting fake confirmer, because
the new parameter DENIES by default. Existing assertions otherwise untouched.
Cases ADDED:

- The confirmer is asked with B2's OWN metadata: the prompt's fileName and
  contentSha1 come from getFileInfo, not from the caller's arguments. DECOY, and
  the one that guards the actual reported bug — a test asserting merely that the
  confirmer was called passes while the human is shown the model's claims.
- A refused delete never calls deleteVersion. DECOY: without it the gate is
  advisory.
- A refused delete writes no intent record and never calls downloadById, and the
  log holds exactly one `phase: 'refused'` line. DECOY: without it a declined
  deletion still archives the bytes and logs an intent nobody authorised.
- A confirmer that THROWS refuses rather than proceeds. DECOY: without it any
  exception in the confirmation path becomes a silent delete.
- Called with only three arguments, deleteFileVersion refuses. DECOY: without it
  a future call site drops the guard in silence.

### tests/audit-log.test.ts (modified)

- A `phase: 'refused'` record round-trips as one line of valid JSON carrying its
  outcome and reason.

## Files

- src/confirm.ts — new, mode selection, the form path, policy constants.
- src/confirm-listener.ts — new, the one-shot 127.0.0.1 page for URL mode.
- src/audit-log.ts — modified, AuditPhase gains 'refused', outcome gains three values.
- src/b2/delete.ts — modified, the confirmer parameter, the new order, the
  refusal record, the corrected doc comment.
- src/server.ts — modified, wires the real elicitor, updates the tool description.
- tests/confirm.test.ts — new.
- tests/confirm-listener.test.ts — new.
- tests/delete.test.ts — modified, PROTECTED: existing cases gain an accepting
  fake, five cases ADDED.
- tests/audit-log.test.ts — modified, one case ADDED.
- README.md — modified. The "cannot be aimed loosely" bullet and the tool table
  row both repeat the claim this slice disproves.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. Newly parked by this slice:

- A confirmation channel for clients supporting NEITHER mode. Fail-closed is the
  answer for 011; an environment override was considered and rejected, because it
  would be set once during verification and never unset, silently disabling the
  guard in the client the slice exists for — the shape of the inspector-2.1.0
  scar. A /dev/tty prompt was also rejected: Claude Desktop has no controlling
  terminal, so it would fire only during verification, an escape hatch in a
  costume. Recorded so neither is relitigated.
- Extending confirmation to b2_hide_file. Hiding is reversible, which is why 006
  did not gate it on the audit log either.
- Reusing the URL-mode listener for anything else (a richer approval page,
  credential entry). It is deliberately one-shot and single-purpose.

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED, pre-approved. tests/confirm.test.ts and
  tests/confirm-listener.test.ts are NEW and qualify as the only regression
  coverage for this guard; append an entry for each naming its decoys.
  tests/delete.test.ts is already listed and its entry must be AMENDED: it
  enumerates exactly three decoys, so a reader would not know the five added
  here are load-bearing.
- CLAUDE.md > Rules — the destructive-tool rule states the id "has to come from
  a listing a human can see," which the demo disproved. Propose replacing that
  clause with the confirmation requirement, keeping the exact-identifier and
  audit-record clauses. CLAUDE.md is protected: propose, do not apply.
- CLAUDE.md > What NOT to do — propose a fourth entry in the dependency-shape
  series: never design against a protocol capability without checking what the
  CLIENT declares. The SDK was read correctly and the design was still wrong,
  because the SDK is not the client.
- CLAUDE.md > Commands — the Deletion verification bullet needs its client
  changed, since the pinned inspector CLI can no longer delete.
- STATE.md — REQUIRED. Add a Plan 011 section.
- ROADMAP.md — add row 011 to the index table and a Done entry.

## Verification

Rules for this section live in CLAUDE.md > Verification.

### Outcome — what this feature now does

Before destroying a version, the server asks you directly, through your MCP
client, showing the exact file id, the file name, the size and the SHA-1 that B2
reports for that id — and nothing is destroyed unless you answer yes. The model
cannot answer for you. A client that cannot ask you is refused outright. Before
this slice, a model could obtain a file id itself, describe the file in its own
words, accept "go ahead" as the confirmation, and delete.

### Steps — confirm it by hand

Prerequisite: `nvm use`, then the b2 helper and `BUCKET=felipe-prompt-gate`.

1. `npm test` — expected: zero failures. The count grows from 145 by roughly 24
   (confirm, confirm-listener, five in delete, one in audit-log); the exact
   number is a prediction to be corrected against the real run, not a target.
   `npx tsc --noEmit` clean.
2. Upload a throwaway and capture its id:
   `b2 b2_upload_file --tool-arg bucketName=$BUCKET --tool-arg localPath=hello.txt`,
   then `b2 b2_list_files --tool-arg bucketName=$BUCKET --tool-arg prefix=hello`.
   Assign it bare, per the Commands gotcha: `FID=4_z...`
3. Audit gate, UNCHANGED — input:
   `B2_AUDIT_LOG= npx -y @modelcontextprotocol/inspector@0.15.0 --cli npm run dev --method tools/call --tool-name b2_delete_file_version --tool-arg bucketName=$BUCKET --tool-arg fileName=hello.txt --tool-arg fileId=$FID`
   on that valid, current, matching id. Output: the B2_AUDIT_LOG refusal, NOT the
   confirmation one — proving the audit gate still runs first. No new line in
   b2-audit.jsonl.
4. Fail-closed, NEW — input: the same call with B2_AUDIT_LOG in force
   (`b2 b2_delete_file_version --tool-arg bucketName=$BUCKET --tool-arg
   fileName=hello.txt --tool-arg fileId=$FID`). Output: a refusal naming the
   missing confirmation channel; the file still lists; and `tail -1
   b2-audit.jsonl` is one `"phase":"refused"` line with
   `"outcome":"unconfirmable"`. A guard's failure path firing under a documented
   command.
5. Decline, GUI — launch: restart Claude Desktop with this server configured and
   B2_AUDIT_LOG plus B2_ARCHIVE_ROOT set. Input: ask it to delete hello.txt from
   $BUCKET. Output: a VISIBLE confirmation raised by the server, not by the
   model, showing the fileId, name, byte count and SHA-1. Answer no. Expect: the
   file still lists, nothing appears under B2_ARCHIVE_ROOT, and `tail -1
   b2-audit.jsonl` is one `"phase":"refused"` line with `"outcome":"declined"`
   and no intent line.
6. Accept, GUI — repeat and answer yes. Output: the file stops listing,
   `tail -2 b2-audit.jsonl` shows INTENT then OUTCOME as before, and
   `shasum uploads/hello.txt archive/hello.txt.$FID` matches the sha1 the
   confirmation displayed — 006's four-way SHA-1 match, with the prompt as a
   fourth witness.
7. The original defect — in the same session, ask it to delete a file WITHOUT
   naming an id; let it call b2_list_files itself and summarise. Expect: it
   cannot complete on "go ahead" alone; the server's own confirmation appears
   and carries the id the model never showed.
8. The listener does not outlive the question — during step 5, with the page
   open, `lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN | grep node` shows it; after
   answering, the same command shows it gone.
9. Regression — `b2 b2_hide_file` and `b2 b2_unhide_file` on a second throwaway
   still work with no prompt, and `b2 b2_list_files --tool-arg bucketName=$BUCKET`
   returns its expected count. Confirmation is scoped to the one destructive tool.

### Guards this slice does NOT verify

- Whether Claude Desktop RENDERS a url-mode elicitation usefully is unconfirmed;
  the capability string and an `elicitation/create` handler were found in the app
  bundle, but that is evidence of support, not proof of a working flow. Steps 5-7
  are the check. If it does not work, that must be reported, not worked around.
- The form-mode path has NO client on this machine that supports it — Claude
  Desktop is url-only and the pinned inspector declares no elicitation at all.
  Form mode ships covered by tests against the live SDK over an in-memory
  transport and by nothing else. Named here rather than implied.
- The timeout path: CONFIRMATION_TIMEOUT_MS is asserted by a unit test; no real
  client was left unanswered for three minutes.
- The legacy `{}` normalisation is fixture-only; no real client declaring the
  bare form was available.
- Everything 010 left open stays open: 005's multi-bucket paths, 007's scan cap
  and multi-bucket totals, 009's unrestricted branch, and a Read Only key failing
  at the B2 API.
