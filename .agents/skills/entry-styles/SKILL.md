---
name: entry-styles
description: Icons and colours for files and folders, and the file tree's Custom sort order — the `.appearance.json` vault file (and what may be stored in it), the store the file tree and vault menu read them from, the drag-to-reorder gesture, and the lazily-loaded Lucide set behind the picker. Load before touching entryStyle*, lucideIcons, EntryStylePicker, LucideGlyph, treeSort/treeReorder/treeDrag, the tree's drag and drop, anything that renames/moves/trashes a vault entry, or before storing anything new in a vault file.
---

# Icons, colours and the custom order of files and folders

Files: `utils/entryStyle.ts` (the on-disk model, pure), `utils/entryStyleStore.ts` (external store),
`utils/lucideIcons.ts` (the lazy set + search), `components/EntryStylePicker.tsx` (the context-menu
flyout), `components/LucideGlyph.tsx` (draws an icon from node data), `TreeNode.tsx`, `VaultMenu.tsx`.

## The file

`<vault>/.appearance.json` — `{ version, entries: {path: {icon, color}}, icons: {name: IconNode[]},
order?: {folderPath: childNames[]} }`, `entries` keyed by vault path, **files and folders alike**. Hidden from the tree at the ROOT ONLY
(`buildFileTree`), along with `LEGACY_STYLE_FILE` (`.folders.json`, the name it had while only
folders could be styled — read forward once by App's loader, left on disk, never shown).

- **One file at the root, NOT a dot-file per folder.** `.Assets`/`.Garbage` are per-folder because
  they hold that folder's own content; this is a lookup table, and the tree walk it would be read in
  runs after *every save*. One read per vault open, held in the store from then on.
- **THE ARTWORK IS STORED WITH IT** (`icons`, deduped by name, pruned on write to what is still
  referenced). That is what lets the file tree draw a custom icon with **none of Lucide in the main
  bundle** and with no flash of default icons on a cold start — and it makes the vault
  self-describing, so icons survive a build with a different Lucide, or none.
- **`color` is a NAME, never a hex.** The two values per colour live in `index.css` as
  `--folder-<key>`, one per theme, because one hex cannot be legible on both sidebars. The tint goes
  on the **icon only** (`--entry-color` on `.tree-item-icon`) — a tree of coloured names stops
  reading as a list. On a file a chosen icon REPLACES the type icon, which is the one thing that row
  says on its own, so it is opt-in and the colour is the common case.
- `parseEntryStyles` never throws: this is user-editable text in their vault, and a bad file must
  cost an icon, not the file tree.

## What may be stored where — a USER rule

App-wide settings (theme, fonts, font size, tab size, …) live in **browser storage**, as they always
have. `.appearance.json` holds exactly what it holds today: per-entry icons/colours, their artwork,
and the tree's custom `order`. **Adding any NEW kind of key to it — or any new app-owned vault
file — needs the user's explicit permission first.** Ask; never add one on your own judgement.

## The custom order (sort menu → Custom)

- `order` is keyed by FOLDER path (`''` = root), valued by child NAMES in display order — names, so a
  folder rename re-keys one key. Omitted from the file while empty (an icon-only vault's file is
  byte-identical to before). Names not on disk are ignored; unlisted children follow the listed
  ones in canonical order (`utils/treeSort.ts`, stable sort); a folder with no list is plain A→Z.
  Folders are NOT forced first under Custom. The *selection* of Custom is global
  (`fileTreeSortOrder` in localStorage); only the arrangement is per vault.
- **`order`'s identity must survive every helper that does not change it** (`withEntryStyle`,
  `renameEntry`, `forgetEntry`, `withEntryOrder` on a no-op): FileExplorer subscribes to it (only
  while Custom is chosen — a constant snapshot otherwise), and a fresh object re-sorts the tree.
- Drag: under Custom a dragged tree node's drop belongs to FileExplorer's delegated container
  handlers (TreeNode's folder handlers bail on `isTreeReorderMode() && peekDraggedNode()`); OS files
  and tab drags keep the old paths. `utils/treeReorder.ts` `planTreeDrop` is the pure rule (null = no
  indicator, drop ignored). The indicator is drawn by the target row via the drop-target store in
  `utils/treeDrag.ts` (per-path primitive snapshot), as a `::after` line INSIDE the row box —
  `.tree-item`'s `content-visibility: auto` clips paint to it.
- A cross-folder drop writes the destination's order FIRST, then `moveFile` (whose refresh then
  renders it in place); a failed move restores the old list.

## Keeping it in step

Styles are keyed by vault path, so **every path change has to re-key them**, and for a folder that
means its descendants too (their keys all carry the old prefix):

- `retargetTabs` (rename/move) → `renameEntry`; `handleTrash` and a Trash restore that displaces
  something → `forgetEntry`. Both also carry `order`: the lists keyed by the path (and under it) are
  re-keyed/dropped, and the name is renamed in place / removed from its parent's list. Same hook
  `movePdfRenderData` and `moveAssetRefs` already ride. Neither is gated on `kind`: a file's path is
  a key too, and the folder-only prefix branch simply never matches for one.
- **The vault menu shows a row's icon via `RecentVault.vaultPath`**, resolved in `publishVaults` with
  `root.resolve(handle)` — one round trip per vault, on a list that changes only when a vault is
  opened or forgotten. It is `undefined` for a vault outside the open one and for the open vault
  itself, which then falls back to a plain folder: that vault's look lives in ITS OWN
  `.appearance.json`, which is not the file loaded.
- Writes go through `App.writeEntryStyles`, which sets the store FIRST and writes after — the picker
  is a live preview and is being judged against the real sidebar. It does **not** call `createFile`:
  that one empties the file in a writable of its own (a crash in between loses every icon and the
  order) and then re-walks the whole vault — which, mid-`moveFile`, drew a dropped item in both
  folders, and after a vault switch repainted the old vault's tree. One `getFileHandle({create})`
  writable replaces it whole. Writes are **serialized in call order** on a promise chain, each bound
  to the vault it was issued in — a cross-folder drop writes twice back to back, and overlapping
  writables land in completion order. The loader empties the store the moment the vault changes.
- `order` maps are **prototype-free** (`newOrder`) and read from outside only via `orderListFor`:
  its keys are folder paths, and a root folder named `constructor`/`toString` otherwise crashed
  rename, trash and the Custom sort.

## The icon set

`lucide-static`'s `icon-nodes.json` (1,818 icons, ~91KB gz) + `tags.json` (~43KB gz), both behind a
dynamic `import()` and verified to build as their own chunks. **Nothing the main bundle reaches may
import `lucideIcons.ts`** — same discipline as the PDF/tldraw split.

- `SUGGESTED_ICONS` is what an empty query shows. Lucide is alphabetical, so without it the first
  screen is `a-arrow-down` and thirty alignment glyphs.
- `VISIBLE_ICONS` caps the rendered list at 180: all 1,818 as inline SVGs measured over a second to
  mount. Search is what reaches the rest.
- `searchIcons` ranks (exact name → prefix → substring → keyword) rather than merely filtering, and
  the name's own words are folded into the keywords — Lucide's tags for `folder-open` do not include
  "folder".
