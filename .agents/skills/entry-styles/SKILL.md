---
name: entry-styles
description: Icons and colours for files and folders, and the file tree's Custom sort order — the per-folder `.appearance.json` vault file (and what may be stored in it), the store the file tree and vault menu read, the drag-to-reorder gesture, and the lazily loaded Lucide set behind the picker. Load before touching entryStyle*, useEntryStyles, lucideIcons, EntryStylePicker, LucideGlyph, treeSort/treeReorder/treeDrag/expandedPaths, the tree's drag and drop, anything that renames/moves/trashes a vault entry, or before storing anything new in a vault file.
---

# Icons, colours and the custom order of files and folders

| File | Role |
|---|---|
| `utils/entryStyle.ts` | the on-disk model and every pure helper (its header comment is the long-form why) |
| `utils/entryStyleStore.ts` | external store: `getEntryStyles`, `getEntryStyle(path)`, `getEntryOrder`, `subscribeEntryStyles` |
| `app/useEntryStyles.ts` | reading the files on vault open, the one serialized writer, `handleStyleEntry`, `handleSetTreeOrder` |
| `components/EntryStylePicker.tsx` | the context-menu flyout (`kind: 'entry-style'`, see `app-context-menu`) |
| `components/LucideGlyph.tsx` | draws an icon from stored node data; tiny, safe to import anywhere |
| `utils/lucideIcons.ts` | the lazy 1,818-icon set and its search |
| `utils/treeSort.ts`, `treeReorder.ts`, `treeDrag.ts`, `expandedPaths.ts` | sorting, the drop rule, drag/drop-target stores, which folders are open |
| `TreeNode.tsx`, `FileExplorer.tsx`, `VaultMenu.tsx` | the readers |

## The file: one `.appearance.json` per folder that has something to say

On disk: `<folder>/.appearance.json` = `{ version: 2, entries: { childName: { icon?, color? } },
icons: { iconName: IconNode[] }, order?: { '': childNames[] } }` — it describes **that folder's own
children**, files and folders alike, by NAME. In memory the app works on **one merged view keyed by
vault path** (`entries: { 'Math': …, 'Math/A3.notebook': … }`, `order: { '': […], 'Math': […] }`);
`shardEntryStyles` cuts it into per-folder files and `mergeShard(view, folder, shard)` folds one back.
Every helper, the store and the rows speak the merged view.

- **A look lives beside the thing it describes.** With one root file, opening `Vault/Math` as its
  own vault (Finder, or **Open as Vault**) put the styles *above* the root, unreachable by the File
  System Access API: every icon vanished and the first pick wrote a file the outer vault never saw.
  Sharded, both roots read and write `Math/.appearance.json`. This is the per-folder rule AGENTS.md
  states for `.Assets`, `.Garbage` and `.appearance.json`.
- **Moves are free.** A renamed, moved or trashed folder carries its own file on disk; only its ENTRY
  in its parent's file is re-keyed. The writer **skips** a folder the tree cannot name — one that just
  moved, whose file went with it.
- Hidden at every depth (`isHiddenEntryName` in `utils/vaultEntries.ts`) and refused to the agent at
  every depth (`writeRefusal` in `utils/vaultAgentTools.ts`). The legacy root-only `.folders.json`
  (`LEGACY_STYLE_FILE`) is read forward once and left on disk, hidden too.
- `parseEntryStyles` never throws: this is user-editable text, and a bad file costs an icon, not the
  tree.

**Reads — once per customized folder, per vault open.** The tree walk (`listDir`) already visits
every folder and keeps the handle of each `.appearance.json` it passes on `FileTreeDirNode.styleFile`;
`useEntryStyles` opens only those (root first, depth first), never speculatively, never per tree walk
(the walk reruns after every save). A folder is marked loaded **before** the await, and what the store
already holds **wins** in `mergeShard`, so a read landing late cannot restore an icon just cleared. The
store is emptied in a layout effect the moment `rootHandle` changes.

**Migration is automatic and one-way.** `needsFanOut` reads the SHAPE, not `version`: a key containing
a separator, or an `order` keyed by anything but `''`, means a pre-shard file — read whole as the merged
view and fanned out once the tree lands. Entries for folders no longer in the tree are dropped.

**Writes — `writeEntryStyles(next)`, the only writer.**
- Sets the store **first**, then writes: the picker is a live preview judged against the real sidebar.
- Shards `next`, compares each file's text byte for byte with `shardTextRef` (what that folder's file
  last said), and writes only the files that changed. A folder left with nothing to say has its file
  **removed** (it is the app's own bookkeeping file, not the person's content).
- Serialized in call order on one promise chain, each write bound to the vault it was issued in. A
  cross-folder drop writes twice back to back, and overlapping `createWritable`s land in completion
  order — the older snapshot could win on disk.
- Goes through `handleIO.fileIn(dir, name, true)` + `writeFile`, never `createFile`: `createFile`
  truncates in a writable of its own (a crash in between loses every icon) and re-walks the vault, which
  mid-`moveFile` drew a dropped item in both folders.

**The artwork is stored with the look** (`icons`, deduped by name, pruned on write to what that file
still uses). That is what lets the tree draw custom icons with **none of Lucide in the main bundle** and
no flash of default icons on a cold start, and lets a folder opened as its own vault draw its icons.

**`color` is a NAME** (`ENTRY_COLORS`), never a hex: each name has two values in `index.css`
(`--folder-<key>`, one per theme) because one hex cannot be legible on both sidebars. The tint goes on
the **icon only** (`--entry-color` on the row's icon, via `entryColorVar`); a tree of coloured names
stops reading as a list. On a file a chosen icon replaces the type icon, so it is opt-in; colour is the
common case.

## What may be stored where — the user's rule

App-wide settings (theme, fonts, sizes, …) live in **browser storage** (`utils/storage.ts`).
`.appearance.json` holds exactly: per-entry icon/colour, their artwork, and the custom `order`.
**Any NEW kind of key in it, or any new app-owned vault file, needs the user's explicit permission
first.** Ask; never decide it yourself. (AGENTS.md says the same.)

## Store identity is what keeps the tree cheap

- `getEntryStyle(path)` returns the **stored object**, so each `TreeNode` subscribes to its own path and
  re-renders only when its own entry changes. Never return a fresh `{}` from a selector.
- **`order` must keep its identity through every helper that does not change it** (`withEntryStyle`,
  `renameEntry`, `forgetEntry`, a no-op `withEntryOrder`): `FileExplorer` subscribes to it while Custom
  is chosen, and a fresh object re-sorts the tree. `handleSetTreeOrder` skips the write when
  `withEntryOrder` returns the same object.
- `order` maps are prototype-free (`newOrder`) and read only through `orderListFor`: a root folder
  named `constructor` or `toString` crashed rename, trash and the Custom sort.
- **Which folders are open** is a store too (`utils/expandedPaths.ts`): as a `Set` prop every toggle
  re-rendered every row (measured: 31 ms a toggle on 1,020 rows, 13 ms after). A row subscribes to its
  own path's boolean.
- `handleStyleEntry` / `handleSetTreeOrder` are stable `useCallback`s: `FileExplorer` and `TreeNode` are
  memoized, and one unstable prop from App re-renders the whole tree.

## The custom order (sort menu → Custom)

- `TreeSortOrder` is `name-asc | name-desc | mtime-desc | mtime-asc | custom`; the **choice** is global
  (`fileTreeSortOrder` in browser storage), the **arrangement** is per vault in the files.
- Under Custom, listed names come first in their stored order, unlisted children follow in canonical
  order (stable sort), names not on disk are ignored, a folder with no list is A→Z, and folders are
  **not** forced first.
- The tree is windowed (`FileExplorer` flattens visible rows into a fixed-height list). Under Custom a
  dragged tree node's drop belongs to `FileExplorer`'s container handlers; `TreeNode`'s folder handlers
  bail on `isTreeReorderMode() && peekDraggedNode()`. OS files and tab drags keep their own paths.
- `planTreeDrop` (`utils/treeReorder.ts`) is the pure rule: `null` = no indicator, drop ignored. The
  indicator is drawn by the target row from the drop-target store in `utils/treeDrag.ts` (each row reads
  only its own `TreeDropPosition`), as a `::after` line **inside** the row box — `.tree-item` has
  `content-visibility: auto`, which clips paint to the box.
- A cross-folder drop writes the destination's order **first**, then `moveFile` (whose refresh renders
  it in place); a failed move writes the previous list back.

## Keeping it in step with path changes

Styles are keyed by vault path, so **every path change re-keys them**, and a folder's change re-keys
all its descendants (their keys carry its prefix). `renameEntry` (rename/move, from `useRenameMove` and
the agent host) and `forgetEntry` (trash, and a Trash restore that displaces something) do it, for both
`entries` and `order` (lists keyed under the path move or drop; the name is renamed in or removed from
its parent's list). They ride the same hooks as `movePdfRenderData` and `moveAssetRefs`. Neither is
gated on kind: a file's path is a key too. A new way to rename, move or trash an entry must call them.

**The vault menu** shows a recent vault's icon via `RecentVault.vaultPath`, resolved with
`root.resolve(handle)` in `context/recentVaults.ts`. It is `undefined` for a vault outside the open one
and for the open vault itself, which falls back to a plain folder: that vault's own look lives in its
parent's file, which is not loaded.

## The icon set (`utils/lucideIcons.ts`)

`lucide-static`'s `icon-nodes.json` (1,818 icons, ~91 KB gz) and `tags.json` (~43 KB gz), both behind a
dynamic `import()` and built as their own chunks. **Nothing the main bundle reaches may import
`lucideIcons.ts`**; `EntryStylePicker` is a module slot in `ContextMenu` for that reason. App and board
chrome icons that need Lucide artwork copy the node data verbatim into source
(`components/icons.tsx`, `whiteboard/chrome/boardIcons.ts`, `toolIcons.tsx`) and draw it with
`LucideGlyph` — never by importing the set.

- `SUGGESTED_ICONS` is the empty-query screen (Lucide is alphabetical; otherwise the first screen is
  `a-arrow-down` and thirty alignment glyphs).
- `VISIBLE_ICONS` (in the picker) caps rendering at 180: all 1,818 inline SVGs took over a second to
  mount. Search reaches the rest.
- `searchIcons` ranks exact name → prefix → substring → keyword, with the name's own words folded into
  the keywords (Lucide's tags for `folder-open` do not include "folder").
- The picker does not close the menu on a pick (icon and colour are two choices) and seeds its state
  from the entry, because entries are built once at raise time.
