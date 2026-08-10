# Plan 00N — <feature name>

## Context

<What's NEW or DIFFERENT since the last plan — not a re-listing of every file
and test the repo already has (that's claude-plans/STATE.md). If this plan
reuses an earlier plan's pattern, cite CLAUDE.md > Established conventions by
name rather than re-describing it.>

**Decisions (confirmed with the user):**

- Scope of this feature: <what's IN>
- <Any policy/default chosen on your behalf — state and flag it>

## Dependencies

<New external libraries this feature adds, each with the WHY and version. "None —
reuses existing stack" is a valid, expected entry. Do not invent dependencies to
fill this section; every added library is surface area.>

- <library==version> — <why it's needed>

## Goal of this feature

<One or two sentences: what this feature adds and what it deliberately does not do.>

## Design

### <file> (location)

<Key surface / signatures for the new code, what it exposes.>

- <Design decision, with the WHY>
- <How it connects to what earlier plans built>
- <Validation / error behavior>

### <test file>

<Cases for the new behavior:>

- <case>
- <edge / error case>

## Files

Every path must be a concrete, exact name — not a description, not a count.
If a name can't be fixed yet (e.g. it depends on a runtime value), give the
exact NAMING RULE instead of the name, precisely enough that no filename
choice is left for implementation time.

- <exact/path/file.ext> — new or modified, <what changes>.
- <exact/path/test_file.ext> — new, the cases above.

## Out of scope (parked)

Full roadmap: see claude-plans/ROADMAP.md. List only what THIS slice newly
parks below; do not repeat the existing roadmap.

- <new item this slice specifically parked, if any>

## Follow-ups after implementation (not code changes in this slice)

- Protected files — REQUIRED, answer even if the answer is none. List every file
  this feature creates that meets the criteria in CLAUDE.md > Protected files.
  Appending those entries is pre-approved: apply them, then report what you
  appended. Writing "none qualify" is a valid answer; omitting this line is not.
- <Any other CLAUDE.md harvest this feature triggers — new command, new rule,
  new scar. Propose the exact edit for approval; the rest of CLAUDE.md is
  protected.>
- STATE.md — REQUIRED. Update claude-plans/STATE.md with every file this plan
  added or modified, one line each. This is pre-approved (STATE.md is not
  protected): update it directly, then report what you added.

## Verification

Rules for this section live in CLAUDE.md > Verification. Fill the shape below;
do not restate the rules here.

### Outcome — what this feature now does

<One or two plain-language sentences a non-coder could confirm. State what is
DIFFERENT from before this slice, e.g. "Quotes now never repeat twice in a row.">

### Steps — confirm it by hand

1. <setup command, if any new deps> — expected: <installs, no errors>
2. <full test command — this slice's tests plus all earlier slices> — expected: <all pass>
3. <smoke check for the new behavior> — expected: <printed value, or launch command
   plus expected visible result for an interface slice>