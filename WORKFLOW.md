# Workflow

This file explains what each piece of the starter kit is for and how they fit
together. Read this once per project, or whenever the flow feels unclear.

## The pieces

### CLAUDE.md — the constitution

The one file every session reads first. It is protected: never edited
silently, always proposed for approval, one exception below.

- **Overview** — what this project is, 2-3 sentences. Filled in at project
  start, once.
- **Stack** — versions. Starts blank, filled in by plan 001 once the stack is
  chosen.
- **Commands** — run/test/lint commands. Starts blank, grows one line at a
  time as each plan makes a new command real.
- **Verification** — the RULES for how every plan proves itself (two
  commands, expected output stated, real output checked before reporting
  done). This is the single source of truth; plan files only fill the SHAPE
  it defines, they never restate the rules.
- **Rules** — durable project-specific rules, earned by real friction. Empty
  until the project earns one.
- **What NOT to do** — anti-patterns, one per real mistake made and fixed.
  Empty until the project earns a scar. Each entry names the mistake and why
  it's wrong, so the lesson survives without the conversation that taught it.
- **Protected files** — files that need explicit approval before being
  touched: CLAUDE.md itself, .env, credentials, and anything that's the only
  regression coverage for a fixed bug. One exception: appending a NEW entry to
  this list is pre-approved — do it the moment the file is created, don't
  save it for later.
- **House rules / Git / Project setup / Environment / Docs** — fixed,
  universal conventions (no emojis, secrets in .env, never push without
  asking, etc). Written once at project start, rarely touched again.
- **Workflow conventions** — the meta-rules governing how plans themselves
  get written (one plan per feature, Files section must name exact paths,
  Out of scope points at ROADMAP.md instead of repeating it, etc).
- **Established conventions** — patterns already used once (a CLI shape, an
  error-handling convention). The second plan to use the same pattern CITES
  this section by name instead of re-describing it. Starts empty; grows as
  patterns repeat.

### claude-plans/ — the planning folder

- **templates/001-template.md** — structure for the very first plan.
- **templates/002-and-above-template.md** — structure for every plan after
  that (assumes a skeleton already exists, so it doesn't recreate one).
- **00N-<name>.md** — the actual numbered plans, one per feature, written
  BEFORE any code. If the numbered file isn't on disk, the plan doesn't
  exist and implementation must not begin.
- **ROADMAP.md** — the full Planned/Possible list, in one place. Every
  plan's Out of scope section points here instead of repeating the same
  list plan after plan. Move an item to Done with the plan number that
  shipped it.
- **STATE.md** — a living one-line-per-file inventory of what exists and
  what plan built it. A new plan's Context section says "see STATE.md"
  instead of re-listing every file the repo already has. Updated as a
  REQUIRED step after every plan lands, same status as filling in Stack and
  Commands.

Why both ROADMAP.md and STATE.md exist: without them, every new plan has to
reconstruct "what already exists" and "what's still coming" from scratch,
which is why early plans in this kit kept growing — each one re-explained
the whole project's history. These two files are the fix: state the facts
once, point to them from then on.

### claude-logs/ — the iteration log folder

- **README.md** — the convention: one file per bug that survives 3 attempts,
  named for the bug, logging what was tried / the result / why it failed,
  per attempt. Stays otherwise empty. A bug fixed in 1-2 tries needs no
  entry — this is for the ones that actually taught something.

## The loop — first plan

1. **Plan mode.** Prompt: read CLAUDE.md, plan the first slice using
   `templates/001-template.md`, write `claude-plans/001-<name>.md`. Confirm
   ROADMAP.md and STATE.md exist as empty placeholders.
2. **Review the plan** — goal, in/out of scope, every file path named
   exactly, Step 0 creates only what's needed.
3. **Implement.** Get out of plan mode, prompt it to build and run tests,
   watch for drift and correct on the first bad edit.
4. **Verify + commit.**
   - Run the test command and the smoke check yourself; compare real output
     to what the plan said to expect.
   - Ask it to prep the CLAUDE.md harvest (Stack, Commands, Established
     conventions, any earned Rule/anti-pattern/protected file) — approve or
     edit before it touches the file.
   - Ask it to update STATE.md and ROADMAP.md directly (pre-approved).
   - Check claude-logs/ — still empty unless a bug earned an entry.
   - `git add` → review diff → commit (not push, unless you decide to).
5. **Session close-out:** verify everything works → `git status` clean →
   committed → rename the session to the plan number → `/clear`.

## The loop — every plan after

Same shape, two differences:

1. **Plan mode prompt** reads CLAUDE.md, STATE.md, and ROADMAP.md — NOT
   every prior numbered plan file. STATE.md is the current inventory; citing
   Established conventions replaces re-describing a pattern already in use.
2. **Verify step** runs the FULL test suite (all plans' tests together, not
   just the new one), and the harvest step is the same as above.

## The meta-rule

Everything above is one principle: the chat is scratch space, the files are
the only durable memory. If a decision, a fix, or a lesson only exists in
the conversation, it does not exist once you `/clear`. Every step in this
loop that says "update a file" exists to move something out of the chat and
into a place the next plan — or the next session, a year from now — can
actually find it.