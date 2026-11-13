# Local note relationships (C-11: D07 and D08)

Only browser runs against the real app are used. No application module is
imported into the page. The small `browser.mjs` helpers seed named OPFS storage,
observe platform canvas calls, and drive the actual vault/tree/editor/graph UI.
Chrome for Testing 157.0.8103.39 and Playwright 1.63.0 are asserted. Reload uses
real IndexedDB folder-handle storage, no shim. External origins are blocked; web
anchors are inspected, never followed. No native-disk/FSEvents claim is made.

## D07

`d07.mjs` opens one fixture note per classification case, including http/https,
protocol-relative, file/custom schemes, drive/UNC forms, implicit www/email,
titles/query/fragment/parenthesized web destinations, local/root/space/folder
positives, destination-versus-label provenance, malformed escapes, controls and
traversal. The extraction grammar is intentionally today's regex, not a new parse:
syntax that did not previously count does not begin counting in this milestone.

It preserves the real https anchor, then reads backlinks by opening each exact
local target path through the tree. The expected source identities are compared,
not just total links. A screenshot and observed filled circles/edge segments
assert that no URL-derived unresolved node exists. The same checks run cold,
after an in-app Cmd+S, and a true reload. Its disk witness first waits for a
specified count of completed successful closes at that path (seed/outside closes
also count), times out as a harness fault, then reads once. Only NotReadableError
has bounded retries; NotFoundError is never retried. This mirrors V-01a's pending
readWitness API rather than polling bytes while a writer might still be open. The fixture has real local targets, so deleting all extraction
cannot falsely pass. Targets are unique basenames; duplicate policy is D08.

The graph applies `localMarkdownTarget` before discarding any provenance. It uses
the reader's WHATWG URL interpretation and implicit www/email forms, but does not
reuse `externalHref`'s null result: that groups blocked unsafe absolute URLs with
local paths. Utils must not import the editor/CodeMirror. No reader code, href
allowlist, sink or navigation affordance is changed. Decode is component-wise,
invalid escapes/separators/controls are refused, dot segments cannot escape the
vault root, and a single literal leading slash remains local. Both cold reads and
own-save priming use extraction schema 2. The cache is currently memory-only;
there is no persisted index to migrate in this package.

Witness before fix, at lane HEAD951dd63: the https anchor was intact while README
backlinks included E01_http/E01_https and other nonlocal sources; the real graph
also drew those edges. The run failed `FAIL D07-external`, not a harness error.
Evidence: `W/scratch/c-e/C-11-D07-before/{report.json,cold.png,stdout.txt}`.

Mutants apply with `git apply` to scratch source copies, built using the normal
production configuration and separate installs:

- `d07-skip-classification.patch`: restores raw/whole-string decode extraction.
  The same gate must fail `FAIL D07-external` (otherwise web provenance is lost).
- `d07-drop-local.patch`: removes valid Markdown-target extraction. The same gate
  must fail `FAIL D07-local` (otherwise dropping all relationships can pass).

## D08

`d08.mjs` starts with `source.md → [[Note]]`, `a/Note.md` containing FIRST NOTE,
`z/Note.md` containing LAST NOTE, plus a nonduplicate Unique control. It clicks the
real rendered wikilink, records exact active-tab path and backlinks, then opens
the graph. A canvas observer supplies the drawn edge coordinates; hovering its
source must show the real source tooltip. Clicking the painted target opens the
actual note; its tab path and unique document marker identify it unambiguously.
The graph module is never called directly. Both duplicates stay in the tree.

Name descending, modified-time, Custom and name ascending presentation must not
retarget links. The Custom fixture uses the EXISTING appearance-file schema to
put z before a, and the UI must actually show that order. Suffix/heading/alias
wikilinks are each clicked. An in-app rename of a/Note.md to a/Other.md makes the
next canonical duplicate the target, including after a graph trip (cached editor
state) and reload. The singleton control must keep its backlink throughout.

Witness before fix, HEAD951dd63: the wikilink opened a/Note.md / FIRST NOTE with
zero backlinks; following the actual painted edge opened z/Note.md / LAST NOTE.
The candidate assertion failed `FAIL D08-target graph z/Note.md != a/Note.md`.
Evidence: `W/scratch/c-e/C-11-D08-before/{report.json,cold.png,stdout.txt}`.

`getNoteResolver(fileTree)` owns an ordered basename→paths index per canonical
immutable tree identity. Graph resolution and the App callback must read that same
revision; a save or presentation sort does not rebuild it. `resolve` returns a
path; `resolveNode` returns the tree's actual file node for opening. Graph keeps
its existing baseName/collectMarkdownFiles exports as re-exports of this pure
module, avoiding a dependency cycle.

The old App click already uses first-match semantics, so ordinary fixtures alone
cannot prove that the callback uses the shared rule. `d08-last-wins.patch` changes
ONLY the resolver to last-wins. The gate's `--resolver-probe=last` arm then requires
both the real click and graph to use z/Note.md. Without the App seam it fails
`FAIL click-graph-agree click a/Note.md != graph z/Note.md`; with the seam it must
pass the whole flow. The SAME patch under the NORMAL invocation remains a mutant:
both consumers agree on z, but the first-match requirement must fail D08-target.
This probes coupling without changing product policy or shipping the patch.

## Commands and current evidence status

`W=/Users/adham/Developer/bme-impl`, `L=$W/scratch/bin/bme-lock`.
Build through L with scratch config `W/scratch/c-e/c11-vite.config.mjs`; root is
this lane, cache/output stay in scratch. Serve only immediately before a run:
`L serve -- ./node_modules/.bin/vite preview --config <cfg> --outDir <output>
--port 6364 --strictPort`. Stop the preview as soon as the run ends.

From the lane, the same invocation is used on clean and matching mutant outputs:

```sh
L run -- node verify/core/C-11/d07.mjs --url=http://localhost:6364/ --out=<report-dir>
L run -- node verify/core/C-11/d08.mjs --url=http://localhost:6364/ --out=<report-dir>
```

D07 candidate PASS cold/save/reload: `W/scratch/c-e/C-11-D07-after/report.json`.
The 35-note fixture retains all seven exact local relationships and no URL/path
placeholder. Skipped-classification mutant: Node exit1 with FAIL D07-external,
wrapper verified that prefix (report under `C-11-D07-skip-run`). Dropped-local
mutant: Node exit1 with FAIL D07-local, prefix likewise verified (report under
`C-11-D07-drop-run`). Both were separately installed and built in scratch using
the normal production configuration. Typecheck/lint passed through L; logs
`W/scratch/c-e/C-11-{typecheck,lint}.txt`. Earlier queue-only cancellations during
the timing window are not gate results.

Review follow-up adds real `C#.md` and `What?.md` files and `[C#](C#.md)` /
`[What?](What?.md)` fixture rows. Reading mode renders both as inert SPAN link
marks (no href or wikilink target). Clicking each stays on its source throughout
a bounded negative UI observation; neither opens its existing local target.
Thus rejection matches the observed reader, rather than assuming those filenames
are invalid. The extended 39-note gate PASS cold/save/reload, still seven local
edges and zero backlinks on those two targets. Evidence and per-phase reader
markup/click observations: `W/scratch/c-e/C-11-D07-punctuation-reader/report.json`.

D08 graph-side normal candidate PASS: `W/scratch/c-e/C-11-D08-graph-after`.
D07 regression after graph/resolver integration also PASS (`C-11-D07-after-resolver`).
The last-wins probe without the App seam failed its named click-graph-agree
assertion, validated by an exit+reason wrapper (`C-11-D08-probe-without-seam`).
Completed-close witness revision PASS on both gates: `C-11-D07-close-witness`
and `C-11-D08-close-witness` record successful close count 2 (including the seed),
then one successful native read, attempts=1. App seam's passing probe and normal
last-wins mutant runs are still pending. Do not treat an interrupted run, patch failure, timeout,
wrong URL or other setup failure as a mutant kill; match its specific reason
following a clean pass. Save-path timing sign-off
remains pending with the benchmark owner, not claimed by these functional runs.
