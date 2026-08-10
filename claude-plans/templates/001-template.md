# Plan 001 — <slice name>

## Context

<Where the repo stands now (what files exist — check claude-plans/STATE.md,
which starts empty on this first plan), and what CLAUDE.md says this project
is. Note which CLAUDE.md sections this plan will settle — e.g. Stack and
Commands were left blank and this plan fills them for the first slice.>

**Decisions (confirmed with the user):**

- Language / stack: <chosen, with the reason tied to a constitution rule>
- Scope of slice 001: <the smallest testable slice — what's IN>
- <Any policy/default the model chose on your behalf — state it and flag it so it can be revisited>

## Dependencies

<External libraries this slice uses, each with the WHY and version. "None
(stdlib only)" is a valid, expected entry — do not invent dependencies to fill
this section. Every added library is surface area, so name why it earns its place.>

- <library==version> — <why it's needed>

## Goal of this slice

<One or two sentences: what this slice produces and, just as important, what it
deliberately does NOT do (no I/O, no CLI, no runnable app yet, etc.).>

## Design

### <file> (location)

<The public surface — key function/signature(s), what it exposes.>

- <Design decision, with the WHY (which rule / constraint drives it)>
- <Design decision, with the WHY>
- <Validation / error behavior — what raises, when, and why it's policy in code>

<Note any per-function purpose comments or conventions required by House rules.>

### <test file>

<Test framework choice + why. Then the cases:>

- <case>
- <case>
- <edge / error case>

## Files

Every path must be a concrete, exact name — not a description, not a count.
If a name can't be fixed yet (e.g. it depends on a runtime value), give the
exact NAMING RULE instead of the name, precisely enough that no filename
choice is left for implementation time.

- <exact/path/file.ext> — new, <what it holds>.
- <exact/path/test_file.ext> — new, the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. List only what THIS slice newly
parks below; do not repeat the existing roadmap.

- <new item this slice specifically parked, if any>

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED, answer even if the answer is none. List every file
  this slice creates that meets the criteria in CLAUDE.md > Protected files.
  Appending those entries is pre-approved: apply them, then report what you
  appended. Writing "none qualify" is a valid answer; omitting this line is not.
- Fill CLAUDE.md Stack section: "<...>".
- Fill CLAUDE.md Commands section: "<only commands that work AFTER this slice>".
  (Stack and Commands are inside a protected file — propose the exact edit for
  approval rather than editing it silently.)
- STATE.md — REQUIRED. Update claude-plans/STATE.md with every file this plan
  added, one line each. This is pre-approved (STATE.md is not protected):
  update it directly, then report what you added.

## Verification

Rules for this section live in CLAUDE.md > Verification. Fill the shape below;
do not restate the rules here.

### Outcome — what this slice now does

<One or two plain-language sentences a non-coder could confirm: what the code can do
that it couldn't before. For a logic-only slice, name the capability that now exists
in the core, even though there's no UI yet.>

### Steps — confirm it by hand

1. <setup command> — expected: <installs, no errors>
2. <test command> — expected: <e.g. "6 passed", exit 0>
3. <smoke check> — expected: <printed value>
