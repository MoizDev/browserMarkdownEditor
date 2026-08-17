# dev-loop plan structure

Every plan written in a dev-loop run uses this shape — the three competing plans from Phase 1
and the single merged `plan.md` that survives Phase 2. Written by `sub-planner` and
`plan-orchestrator`, audited against by `sub-plan-auditor` and `plan-auditor`, executed by
`implementation-orchestrator` and `implementer`.

A plan is not an essay about the task. It is the document four agents will execute in
parallel without talking to each other. If two implementers could read a step and write
different code, the step is not finished.

---

## 1. The task, and what "done" means

Restate the task in your own words, then give the acceptance criteria: **observable**
statements a reviewer can check, phrased as what a user or a test can see. "Refactored
cleanly" is not one. "Submitting the form with an expired token shows the re-authentication
prompt instead of a blank page, and the draft survives it" is.

For a bug fix, the first acceptance criterion is always the reproduction: the exact steps
that show the bug today, and the same steps showing it gone.

## 2. Current state

How this works **today**, with `path:line`. The mechanism, not a summary of the file names —
the flow of control, where state lives, what already handles the case you are about to
change. Name the code you will be standing on.

## 3. Approach, and what you rejected

The approach, and why it is the right one for this codebase specifically — its conventions,
its invariants, its existing seams. Then the alternatives you considered and rejected, each
with the reason. The rejected list is what stops Phase 2 and Phase 4 relitigating a decision
you already thought through.

Weigh quality, simplicity, robustness, and long-term maintainability. Do not weigh how long
it takes to build.

## 4. Work breakdown

Ordered steps. Each step:

- **What changes** — the files, and for each, what happens to it (new / modified / deleted).
- **How** — the actual shape of the change: signatures, types, the data flow, the edge cases
  it must handle. Concrete enough that two implementers would produce the same thing.
- **Why here** — what makes this the right file and the right layer.
- **Depends on** — the steps that must land first, if any.
- **Acceptance** — how someone verifies this step alone is correct.

Group the steps into work packages that can be owned by different agents **without two of
them ever touching the same file**. Shared files — types, barrel exports, migrations, schema
definitions, the repo's instruction file — belong to exactly one package. Say which.

## 5. Data and schema

If persistent state changes:

- **The migration**, written out, destined for the project's migrations directory in its
  existing naming convention. Every schema change lands as a file, whether it was applied
  through a tool, an MCP server, or a console.
- **Access control** — the policies, grants, roles or permission checks the new or changed
  structure needs, and whether it is reachable by end users at all.
- **Derived artifacts** — generated clients, hand-maintained type definitions, fixtures,
  seeds, or documentation that describe the schema and will not update themselves.
- **Existing rows** — what they look like after the change, and whether anything needs
  backfilling.

Verify every claim here against the live schema through whichever inventoried MCP server or
tool is the authority on it (`.dev-loop/context/00-mcp.md`); files that describe the schema
can drift from the schema.

If persistent state does not change, say so explicitly. Silence reads as "nobody checked".

## 6. Tests

What proves this works, at each level:

- **Unit** — using the project's own runner and conventions, over the layers it actually
  covers. The cases, including the failure modes, not just the happy path.
- **End-to-end** — the flows Phase 4 must exercise through the real interface, in the order a
  user would hit them. Name explicitly what is **only** verifiable here because no unit test
  in this project reaches it.
- **Regression** — what nearby behaviour could plausibly break, and what covers it.

For every test that will assert an absence, say how it proves it can detect a presence: a
check that cannot distinguish "passed" from "did not run" is not a check.

## 7. Invariants at risk

The load-bearing rules from the repo's instructions and from the code that this change comes
near, each with: what it is, why it exists, and specifically how this plan avoids breaking it.
Where the repo's instructions keep an explicit invariant list for a subsystem this change
touches, walk that list item by item rather than summarising it.

## 8. Documentation

What the repo's instruction files must say after this change that they do not say now — new
subsystem, new convention, new invariant, or an existing line this change makes stale. Keeping
them current is part of the change, not a follow-up. Same for any user-facing or API
documentation the change falsifies.

## 9. Risks, unknowns, rollback

What could go wrong, how likely, what it would look like when it does, and what to do about
it. What you could not determine from the code and how the implementer should resolve it. How
to undo this if it turns out to be wrong.

## 10. Out of scope

What this change deliberately does not do, and why. This is the boundary Phase 4 uses to tell
a real finding from scope creep, so be specific — vagueness here becomes an extra review
iteration later.
