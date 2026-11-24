# W-01 canvas caller safety audit

This is the `isCanvasFile` caller inventory for the prelude, including unchanged callers. Imports
and the predicate declaration are not additional operations. `.drawing` remains textual JSON on
disk (`isTextFile` stays true); the loaded `unsupported` representation supplies no write authority.

| Caller | Why the native suffix is safe here |
| --- | --- |
| `App.tsx:166` — `tracksAssets` | Excludes every canvas from Markdown embed tracking; a native drawing does not enter the note asset-diff path. |
| `App.tsx:2449` — search reveal | Suppresses character-range reveals for canvases; native content is not indexed and has no CodeMirror view. |
| `App.tsx:2971` — **former** prefetch caller | **Changed to `isDrawingFile`.** Only the legacy extension routes to DrawingPane in this build. `isCanvasFile` here wrongly warmed tldraw for native-only vaults; the network arm reproduces and rejects that mistake. |
| `App.tsx:3865` — `reloadFromDisk` | Replaces the buffer and re-derives `representationFor`; native stays unsupported, not content-writable. It never constructs a text editor or saves the replacement as a user edit. |
| `agentHost.ts:155` — `rememberedPosition` | Reads browser view-position memory only; neither reads nor mutates document bytes. |
| `agentHost.ts:269` — `applyTextChanges` | Native suffix is independently refused immediately before this generic canvas refusal, with a truthful unsupported reason. No native write reaches the text-edit implementation. |
| `agentHost.ts:427` — `openCanvasForAgent` | Independent native guard returns null before the generic canvas allowlist and before quiet-open/show-beside calls. |
| `vaultAgentTools.ts:310` — `assertEditableText` | `assertSupportedCanvasFormat` rejects native before this generic legacy-canvas instruction. The agent is not told to change a native file with canvas_apply. |
| `vaultAgentTools.ts:593` — `vaultRead` | Native follows the canvas branch into `canvasShapesFromAnywhere`, whose first operation rejects native. It never reaches the legacy snapshot parser or text read. |
| `vaultAgentTools.ts:646` — `vaultView` | Its initial `assertSupportedCanvasFormat` rejects native before this branch can open a canvas or capture one. |
| `vaultAgentTools.ts:719` — `vaultSearch` | Removes all canvas files from the content candidate list; native filenames remain searchable, native JSON does not. |
| `vaultAgentTools.ts:872` — `vaultCreate` content policy | Native-specific refusal precedes the generic empty-legacy-canvas allowance. No empty native file can be created here. |
| `vaultAgentTools.ts:883` — `vaultCreate` host invocation | Same earlier native refusal; the host independently refuses native creation too. Only legacy canvases can reach the empty-content branch. |
| `vaultAgentTools.ts:885` — `vaultCreate` success description | Reached only after the native refusal and successful host create; no native file gets a false legacy-canvas success message. |
| `vaultAgentTools.ts:941` — `assertCanvasPath` | Its first call rejects native; both canvas_shapes and canvas_apply use this check before obtaining a live renderer. |
| `documentReading.ts:10` — `classifyRequestedKind` | Legacy drawing/notebook routes are checked first; the generic canvas predicate then fences native as unsupported, with an unavailable buffer and no content write authority. |
| `documentReading.ts:33` — `readingCapabilities` | Omits text/copy/find/emphasis capabilities for canvases; the native unsupported representation already fails canReadTabText as well. |
| `SearchPanel.tsx:66` — index candidates | Excludes every canvas from the content index, including closed native files. |
| `SearchPanel.tsx:94` — open buffer lookup | Returns undefined for canvas content, so native tab buffers cannot leak into search results. |
| `TrashPanel.tsx:222` — preview selection | Refuses the text preview path for native files; no JSON text editor or canvas is loaded in Trash. Native and legacy drawing icons are selected separately. |
| `TreeNode.tsx:414` — default icon | Presentation only: after the notebook-specific icon, every other canvas gets PenTool. No content access or editor routing happens here. |
| `EditorPane.tsx:357` — focused canvas status | Suppresses text count/backlink UI for canvases. The floating renderer list remains explicitly legacy-only (`isDrawingFile || isNotebookFile`), so it never mounts a DrawingPane for native files. |

`isCanvasFile` itself delegates to case-insensitive legacy drawing, native drawing and notebook
predicates. It does not grant renderer or write authority. Other suffix-only checks intentionally
remain narrow: New drawing / createRequest still make `.tldraw`; CanvasPane is reachable only from
the legacy-only floating-renderer list; canvasFileSummary consumes only legacy caller-provided kinds.

`vaultSearch.NON_TEXT_RE` is deliberately unchanged: the actual search candidate paths above already
exclude canvases, while making `.drawing` non-text there would send the open path to an external
browser window instead of the unsupported in-app tab.

The browser run proves native unsupported/no-editor/zero-write routing, content-search exclusion,
legacy rendering, both icons and the native-only/legacy network split. Agent executor and host
refusals are implemented independently; their real-bridge arms remain `pending-V02` under the brief,
not represented as verified by this audit.
