---
name: folder-styles
description: Folder icons and colours — the `.folders.json` vault file, the store the file tree reads them from, and the lazily-loaded Lucide set behind the picker. Load before touching folderStyle*, lucideIcons, FolderStylePicker, LucideGlyph, or anything that renames/moves/trashes a folder.
---

# Folder icons and colours

Files: `utils/folderStyle.ts` (the on-disk model, pure), `utils/folderStyleStore.ts` (external
store), `utils/lucideIcons.ts` (the lazy set + search), `components/FolderStylePicker.tsx` (the
context-menu flyout), `components/LucideGlyph.tsx` (draws an icon from node data), `TreeNode.tsx`.

## The file

`<vault>/.folders.json` — `{ version, folders: {path: {icon, color}}, icons: {name: IconNode[]} }`,
hidden from the tree at the ROOT ONLY (`buildFileTree`).

- **One file at the root, NOT a dot-file per folder.** `.Assets`/`.Garbage` are per-folder because
  they hold that folder's own content; this is a lookup table, and the tree walk it would be read in
  runs after *every save*. One read per vault open, held in the store from then on.
- **THE ARTWORK IS STORED WITH IT** (`icons`, deduped by name, pruned on write to what is still
  referenced). That is what lets the file tree draw a custom icon with **none of Lucide in the main
  bundle** and with no flash of default icons on a cold start — and it makes the vault
  self-describing, so icons survive a build with a different Lucide, or none.
- **`color` is a NAME, never a hex.** The two values per colour live in `index.css` as
  `--folder-<key>`, one per theme, because one hex cannot be legible on both sidebars. The tint goes
  on the **icon only** — a tree of coloured names stops reading as a list.
- `parseFolderStyles` never throws: this is user-editable text in their vault, and a bad file must
  cost an icon, not the file tree.

## Keeping it in step

Styles are keyed by vault path, so **every path change has to re-key them**, and for a folder that
means its descendants too (their keys all carry the old prefix):

- `retargetTabs` (rename/move) → `renameFolder`; `handleTrash` → `forgetFolder`. Same hook
  `movePdfRenderData` and `moveAssetRefs` already ride.
- Writes go through `App.writeFolderStyles`, which sets the store FIRST and writes after — the picker
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
