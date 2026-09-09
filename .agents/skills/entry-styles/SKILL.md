---
name: entry-styles
description: Icons and colours for files and folders — the `.appearance.json` vault file, the store the file tree and vault menu read them from, and the lazily-loaded Lucide set behind the picker. Load before touching entryStyle*, lucideIcons, EntryStylePicker, LucideGlyph, or anything that renames/moves/trashes a vault entry.
---

# Icons and colours for files and folders

Files: `utils/entryStyle.ts` (the on-disk model, pure), `utils/entryStyleStore.ts` (external store),
`utils/lucideIcons.ts` (the lazy set + search), `components/EntryStylePicker.tsx` (the context-menu
flyout), `components/LucideGlyph.tsx` (draws an icon from node data), `TreeNode.tsx`, `VaultMenu.tsx`.

## The file

`<vault>/.appearance.json` — `{ version, entries: {path: {icon, color}}, icons: {name: IconNode[]} }`,
keyed by vault path, **files and folders alike**. Hidden from the tree at the ROOT ONLY
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

## Keeping it in step

Styles are keyed by vault path, so **every path change has to re-key them**, and for a folder that
means its descendants too (their keys all carry the old prefix):

- `retargetTabs` (rename/move) → `renameEntry`; `handleTrash` → `forgetEntry`. Same hook
  `movePdfRenderData` and `moveAssetRefs` already ride. Neither is gated on `kind`: a file's path is
  a key too, and the folder-only prefix branch simply never matches for one.
- **The vault menu shows a row's icon via `RecentVault.vaultPath`**, resolved in `publishVaults` with
  `root.resolve(handle)` — one round trip per vault, on a list that changes only when a vault is
  opened or forgotten. It is `undefined` for a vault outside the open one and for the open vault
  itself, which then falls back to a plain folder: that vault's look lives in ITS OWN
  `.appearance.json`, which is not the file loaded.
- Writes go through `App.writeEntryStyles`, which sets the store FIRST and writes after — the picker
  is a live preview and is being judged against the real sidebar. It calls `createFile` deliberately:
  that primitive opens-or-*truncates*, which is right for a file the app rewrites whole.

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
