# dev-loop charter

**Binding on every agent in a dev-loop run, including the main session.** Read it in
full before you do anything else. Where this charter and your own instructions
disagree, the charter wins — except that the repo's own instructions (§4) win over both.

---

## 1. What a dev-loop run is

One user task, driven through six phases by a fixed tree of agents. Every phase ends
with a written artifact; the next phase starts by reading it. Nobody re-derives what a
previous phase already wrote down.

| Phase                | Owner                                                                                 | Produces                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0 · Exploration      | main session + 4 × `codebase-explorer`                                                | a complete map of the codebase, plus the environment and MCP inventory                      |
| 1 · Plan creation    | `plan-orchestrator` → 3 × `sub-planner` → 1 × `sub-plan-auditor` each                 | three independent plans, merged into one                                                    |
| 2 · Plan review      | `plan-orchestrator` → 1 × `plan-auditor`                                              | the audited, final `plan.md`                                                                |
| 3 · Implementation   | `implementation-orchestrator` → 4 × `implementer` → 1 × `implementation-auditor` each | the code change                                                                             |
| 4 · Review + testing | `review-orchestrator` → 1 × `reviewer` → 3 × `code-reviewer` + 1 × `end-to-end`       | findings, fixes, and a convergence verdict — **repeats until an iteration changes nothing** |
| 5 · Commit + push    | main session                                                                          | a commit on the task branch, pushed                                                         |

The tree is exactly three agent layers deep. Nothing in this pipeline needs a fourth.

The counts above are the whole design. Do not add an agent because a job looks big, and do
not drop one because it looks small — a group that quietly ran at N−1 is a coverage lie.

## 2. Absolute prohibitions

Every agent, every phase. No exceptions, no "just this once".

- **Never `git commit`, `git push`, `git checkout`, `git switch`, `git merge`, `git rebase`,
  `git reset`, `git stash`, `git clean`, or `git restore`.** Only the main session commits and
  pushes, and only in Phase 5. You are already on the correct branch; leave it that way.
- **Never touch an environment or credential file** (`.env*`, key files, service-account JSON,
  CI secrets), and never print a secret, token, key, or password into a report, a log, or your
  final message. Redact to shape (`{status, reason}`).
- **Never ask the user a question.** Subagents have no user. If you are blocked, say so in
  your report and return; the main session is the only agent that may consult the user.
- **Never publish an Artifact**, open an interactive browser session, or start a Workflow. The
  pipeline is exactly the agent tree in §1.
- **Never run a destructive operation against a live or shared environment** — no dropping or
  truncating tables, no unqualified `DELETE`/`UPDATE`, no disabling of access control, no
  deleting buckets, queues, deployments, or branches, no writes to production through an MCP
  server or an admin API. Reads and additive, reversible changes only.
- **Never delete or modify data you did not create.** A dev-loop test identity may only touch
  its own rows.
- **Never write outside the paths you were given.** Your prompt names exactly one report
  path (and, for implementers, one set of owned source paths). Nothing else is yours.

## 3. Git: the canonical commands

The run's base commit is passed to you as `BASE_SHA`. Work is **uncommitted** until Phase 5,
so `git diff BASE_SHA` alone is not complete — it misses new files. The whole-task diff is
always taken from the index, which a writing agent refreshes before spawning readers:

```bash
# Refresh the index (writing agents only — orchestrators and implementers)
git add -A

# The canonical whole-task diff (any agent; readers do NOT run `git add`)
git diff --cached "$BASE_SHA"
git diff --cached --name-status "$BASE_SHA"     # the changed-file set
git diff --cached --stat "$BASE_SHA"            # size of the change

# The working-tree fingerprint used to decide whether an iteration changed anything
git add -A && git write-tree
```

`.dev-loop/` is listed in `.git/info/exclude`, so `git add -A` never stages a run artifact.
Staging is not committing — nothing leaves the working tree until Phase 5.

## 4. The repo's own rules, and the gates

**"The repo's instructions"** means whatever file this repository uses to tell contributors
and agents how to work in it — `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, a `docs/`
convention guide, or several of them. The main session names the actual files in
`.dev-loop/run.md § Repo rules`. Read them before you plan, implement, or review. They are
binding and they are not boilerplate: they record load-bearing invariants that look like
ordinary code until you break one. If the repo has none, that part of your job is empty —
say so rather than inventing rules.

**The gates** are the project's own verification commands, discovered once by the main session
and recorded verbatim in `.dev-loop/run.md § Gates` as four slots:

```
typecheck   static type / compile check   — must be clean
lint        linter                        — must be clean (pre-existing warnings excepted)
test        the test suite                — must pass
build       production build              — Phase 3 and Phase 5 only
```

A slot the project has no equivalent for is recorded as `none`. **Use the recorded commands
verbatim.** Never invent a gate, never substitute a command the project does not use, and
never report a gate green that you did not run.

Two traps that are easy to fall into in any codebase:

- **The installed version of a framework is not the version you remember.** Before writing
  code against a framework, router, ORM, or SDK, check the version the project actually pins
  and read *its* documentation — vendored docs in the dependency directory, the changelog, or
  the official docs for that exact version. Training-data recall is not a source.
- **Every schema change lands as a migration file**, in the project's existing migrations
  directory and naming convention, in the same change — never as a follow-up. If the project
  has generated or hand-maintained schema types, a client, or fixtures derived from the
  schema, updating them is part of the same change too, and hand-maintained ones can drift
  from reality: verify rather than assume.

If a whole-tree formatter or checker is part of the workflow, run it on changed files only
while `.dev-loop/` exists — it would otherwise walk the run's own artifacts:

```bash
git diff --cached --name-only "$BASE_SHA" | xargs -r <the project's formatter, in check mode>
```

## 5. MCP: inventory it, then actually use it

MCP servers are how this pipeline reaches ground truth that is not in the repository — the
live schema, production logs, deployment state, the issue tracker, hosted docs. Guessing at
something a connected server could have told you is a defect, not a shortcut.

**The run has an inventory.** The main session writes `.dev-loop/context/00-mcp.md` during
setup and every agent reads it. It lists **every** server reachable in this run and rules on
each one:

- what it is and what it can do,
- **applicable to this project — yes or no — and why**,
- what each phase should use it for (schema questions, runtime behaviour, requirements,
  deploy state), or the reason it has no role here,
- anything that needs authentication and is unreachable.

Both halves of that ruling matter. Naming the servers that are *not* applicable is what stops
six agents rediscovering the same dead end.

**A tool you cannot see may still exist.** MCP tool schemas are frequently deferred, so
absence from your tool list proves nothing. Discover before you conclude:

```
ToolSearch("+<server or capability keyword>")     # e.g. "+database", "+logs", "+issues"
ToolSearch("select:<exact_tool_name>")
```

Also read the project's MCP configuration (`.mcp.json` or the equivalent for this repo) —
the user's own configuration may add servers beyond it.

**Use them where they are the right tool, not as a formality.** The live system is ground
truth for questions about the live system; generated or hand-maintained files that describe
it are secondhand and can be stale. Where an inventoried server is the authority on a
question your work depends on, query it and cite what it returned.

Within §2's limits: reads freely, additive and reversible changes where the task calls for
them, nothing destructive and nothing in production. If a server is unreachable, say so
plainly in your report and name what you could not verify because of it. Do not guess, and
do not pretend the check happened.

## 6. Artifacts

Everything the run writes lives under `.dev-loop/` at the repo root — **markdown only**,
because the directory sits inside a repo whose formatters and linters walk the tree. Anything
heavy (browser binaries, app copies, screenshots, dependency trees) goes in the out-of-repo
`WORKSPACE` directory named in your prompt.

```
.dev-loop/
  run.md                     run manifest: task, branch, BASE_SHA, WORKSPACE, repo rules, gates, phase log
  task.md                    the user's task, verbatim
  plan.md                    the single authoritative plan
  context/
    00-baseline.md           gate results before any change was made
    00-mcp.md                the MCP inventory and applicability ruling
    01-codebase.md           Phase 0 → 1
    02-plan-handoff.md       Phase 2 → 3
    03-implementation.md     Phase 3 → 4
    04-review-ledger.md      Phase 4, appended per iteration → 5
  phase0/  explorer-N.md
  phase1/  plan-N.md · plan-N-audit.md · synthesis.md
  phase2/  audit.md · revisions.md
  phase3/  packages.md · implementer-N.md · implementer-N-audit.md · orchestrator-review.md
  phase4/  iteration-K/ reviewer.md · reviewer-code-M.md · reviewer-e2e.md · verdict.md
```

Rules: inside the repo, write only to the artifact path your prompt gives you. Under
`WORKSPACE` you may write freely — scoped diffs, file lists, specs, logs — as long as the
filenames carry your own index so two agents never collide. Never edit another agent's
artifact; if you disagree with it, say so in yours. Artifacts are deleted before the Phase 5 commit,
so nothing in them may be load-bearing for the shipped change: anything that must survive
the run belongs in the code, in a test, or in the repo's instructions.

## 7. Spawning: the Standard Preamble

Only these agents may spawn, and only these children:

| Spawner                       | May spawn                                                                                      | Count                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------- |
| main session                  | `codebase-explorer`, `plan-orchestrator`, `implementation-orchestrator`, `review-orchestrator` | 4 / 1 / 1 / 1-per-iteration |
| `plan-orchestrator`           | `sub-planner`, then `plan-auditor`                                                             | 3, then 1                   |
| `sub-planner`                 | `sub-plan-auditor`                                                                             | 1                           |
| `implementation-orchestrator` | `implementer`                                                                                  | 4                           |
| `implementer`                 | `implementation-auditor`                                                                       | 1                           |
| `review-orchestrator`         | `reviewer`                                                                                     | 1                           |
| `reviewer`                    | `code-reviewer`, `end-to-end`                                                                  | 3, 1                        |

Everyone else is a leaf and does the work itself. Leaves have the Agent tool removed, so a
leaf that tries to delegate simply fails.

**Every group is a barrier.** Launch the whole group in ONE message, one `Agent` call per
member, each with `run_in_background: false`. That way the group runs concurrently and you
do not resume until every member has returned. Never start pooling, merging, or fixing
while a sibling is still running. A group of one is still a barrier: spawn it, wait for it,
then act.

**If a member returns nothing, or its artifact is missing or empty**, re-spawn that one
member once with the same prompt plus a note that its predecessor produced nothing. If it
fails twice, record the gap explicitly — in your artifact and in your return — and continue
with the survivors.

Every spawn prompt opens with this preamble, filled in. It is what keeps a child from
re-reading the repo to rediscover facts the run already knows.

```
You are a `<agent-type>` in a dev-loop run, instance <k> of <N>.

RUN FACTS
  repo root   : <absolute path>
  run id      : <RUN_ID>
  branch      : <BRANCH>        — never switch it, never commit, never push
  BASE_SHA    : <sha>           — canonical diff: git diff --cached <sha>
  WORKSPACE   : <absolute out-of-repo scratch path>
  phase       : <n> — <name>

THE TASK, VERBATIM FROM THE USER
<<<TASK
<the user's words, unedited>
TASK

READ FIRST, IN THIS ORDER — these already answer most of what you need
  1. .claude/skills/dev-loop/reference/charter.md
  2. .dev-loop/run.md              — repo rules, gate commands, run facts
  3. <the repo's own instruction files, as named in run.md § Repo rules>
  4. .dev-loop/context/00-mcp.md   — which MCP servers apply here, and to what
  5. <inbound artifacts, most specific last>

YOUR JOB
<what only this instance is responsible for, and what "done" means>

WRITE YOUR REPORT TO
  .dev-loop/<exact path>.md    — the only path you may create or modify

RETURN
<the compact digest spec from §9, tailored>
```

## 8. Evidence standards

This pipeline is exactly where these get violated:

> A check that cannot distinguish "passed" from "did not run" is not a check.

- **Positive control.** Before trusting an empty result, prove your detector fires. A grep
  that errors, a test that skips, a page that never loaded — all look like success.
- **Coverage assertion.** Prove you actually scanned what you claim to have scanned. When
  work is split across agents, verify the union of the parts equals the whole with a
  **set difference**, never a count. Three wrong files and three wrong rows cancel out in a count.
- **Never report green for something you did not exercise.** "Blocked", "not run", and
  "could not reach" are respectable results. A fabricated pass is not.
- **Cite.** Every claim names a file and line, a command and its output, or an observed
  behaviour. "This looks fine" is not a finding and neither is "this looks wrong".

## 9. Return contract

Your final message **is** your return value — it goes into your parent's context, not to a
human. No greeting, no sign-off, no restatement of your instructions. Write the full detail
to your artifact and return a compact digest:

```
charter: read
artifact: .dev-loop/<path>.md
status: complete | partial | blocked
<3–15 lines: what you did, what you found, what is unresolved>
blockers: <none | one line each>
```

Parents: read the artifact when you need the detail. Do not ask a child to repeat itself.

## 10. Actionable vs. nitpick

**The single rubric every auditor, reviewer, and orchestrator in this run uses.** Phase 4
loops until an iteration produces no code change, so the two mistakes do not cost the same:
calling a real defect "taste" ships one bug, while calling taste a defect runs the whole loop
again — and hands the next iteration a fresh diff to have opinions about. Most runs should
reach a clean iteration quickly. When one does not, this section being applied loosely is
almost always why.

**The default verdict is "not actionable". The burden of proof is on the finding.**

A finding is **actionable** — it warrants a code change — only if all five hold:

1. It names a specific file and line, or a specific observable behaviour.
2. It states a concrete consequence: wrong output, crash, data loss, security hole, a broken
   invariant from the repo's instructions, a failing gate, a deviation from `plan.md`, or a
   user-visible defect.
3. It carries a **failure scenario**: specific inputs or state, and the specific wrong result
   they produce. A category of risk is not a failure scenario; an instance of it is.
4. Whoever is about to act on it has **verified it personally** — reproduced it, or traced the
   path in the code and found the defect actually there. A plausible-sounding report from
   another agent is a claim, not evidence.
5. It is not a matter of taste, and not a re-litigation of a decision already recorded with
   reasons.

If you cannot write the failure scenario in one sentence, you do not have a finding. Saying so
is the honest result and it is what lets this loop terminate.

Classify as **actionable** without hesitation: logic errors; unhandled failure modes on paths
that can realistically fail; race conditions and lost writes; auth/ownership gaps; violated
invariants from the repo's instructions; schema changes with no migration file; gate failures
**including pre-existing ones**; missing tests for behaviour this change introduces; a plan
step silently dropped; a user-visible defect seen in end-to-end testing.

Classify as **not actionable** — record it, do not act on it: naming and style preferences;
"consider extracting/refactoring", or any restructuring of code that works; speculative
future-proofing and hardening against inputs the code cannot receive; requests for tests of
behaviour this change did not touch; documentation polish unrelated to the change;
re-litigating a decision Phase 2 or an earlier iteration already settled with reasons; a
defect that can only occur if some other part of the system is already broken; anything
phrased as "might", "could", "consider", "for robustness", or "it would be cleaner" with no
demonstration attached.

**When you are still unsure, apply the blocking test:** would a competent engineer hold up
this change in review over it? If not, it is not actionable. Record it and move on. Unsure
is a "no" — that is what "the default verdict" means.

**Pre-existing problems that are not this task's fault:**

- Red gates (typecheck, lint, test) — **always fix**. The repo's standard is zero, and a red
  gate cannot tell you whether your change broke it.
- A clearly-wrong user-visible defect on a flow this change actually exercises — **may fix**,
  if the fix is small and self-contained. Record it as collateral with its justification.
- Anything else — **record as collateral, do not fix.** Scope belongs to the user. Report it;
  let them decide.

**The bar rises as the loop goes on.** From **iteration 3 onward**, only red gates and
**blocking or significant** actionable findings are fixed; minor ones are recorded as
collateral for the user, however genuine they are. A finding that would reverse something an
earlier iteration deliberately did is not a fix — it is a disagreement between two passes, and
it is escalated to the main session rather than acted on.

**Do not make changes to be on the safe side.** Every change in Phase 4 must cite the finding
that forced it. A change nobody asked for keeps the loop spinning and hides the real signal.

## 11. Context economy

Reading the same file in eight agents is how this pipeline gets slow and inconsistent. Read
your inbound artifacts first — the codebase map, the MCP inventory, the plan, the handoff —
and treat them as true. Then read deeply, and only, the files you will change, review, or
reason about precisely. If an artifact is wrong, say so in your report; do not quietly
re-derive the world.
