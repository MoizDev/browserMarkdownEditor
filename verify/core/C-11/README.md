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
after an in-app Cmd+S (disk completion is awaited with bounded native reads), and
a true reload. The fixture has real local targets, so deleting all extraction
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

The shared resolver and App seam are described in the lane hand-off once wired.
A source-side old-click-versus-shared-resolver difference must be reported
honestly: the old click already uses canonical first-match semantics.

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

D08 candidate and last-wins mutant are still pending. Do not treat an interrupted
run, patch failure, timeout, wrong URL or other setup failure as a mutant kill;
match its specific reason after clean code passes. Save-path timing sign-off
remains pending with the benchmark owner, not claimed by these functional runs.
