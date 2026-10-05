// Which vault entries the app hides, in ONE place.
//
// Two consumers must agree on this or they drift: the file-tree walk
// (FileSystemContext.buildFileTree — what the sidebar, the graph and vault
// search are built from) and the outside-change filter (vaultChanges.ts — which
// observer records are worth any work at all). A change the tree would never
// show must not wake the tree, and a change the tree WOULD show must never be
// filtered out; sharing the predicate is what guarantees both.
//
// Pure: no DOM, no React, nothing from the FS Access API but its two kind names.

import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE } from './entryStyle';
import { ASSETS_DIR, TRASH_DIR } from './assets';
import { ROOT_HIDDEN_DIRS } from './vaultAgentStore';

export type EntryKind = 'file' | 'directory';

/** Git's bookkeeping, file or folder (a worktree or submodule has a `.git`
 *  FILE), at any depth. Exact-case on purpose: git itself only ever writes
 *  `.git`. */
export function isGitName(name: string): boolean {
    return name === '.git';
}

/** Chrome's temporary for a write in progress (`<name>.crswap`): every
 *  createWritable().close() renames it over the file. It is noise at any depth —
 *  a tree walk landing mid-write drew it as a sibling once (see
 *  App.writeEntryStyles), and the observer reports it on every autosave. */
function isSwapName(name: string): boolean {
    return name.endsWith('.crswap');
}

/**
 * The rules, on a bare name. `atRoot` is whether the entry sits directly in the
 * vault root — the only place the app's own files and the agent's folders are
 * hidden. `buildFileTree` calls this once per entry of a walk of thousands, so
 * it takes no array (the public form below does, for callers holding a path).
 */
export function isHiddenEntryName(name: string, atRoot: boolean, kind: EntryKind): boolean {
    // Finder's, not the reader's.
    if (name === '.DS_Store') return true;
    if (isGitName(name) || isSwapName(name)) return true;
    // The app's own record of how things look. Hidden for the same reason
    // .Assets and .Garbage are: it is bookkeeping, not something the reader put
    // in their vault. Root-only, unlike those two — see entryStyle.ts. The
    // legacy name goes too: migration reads it forward and deliberately leaves
    // it on disk, and a file this app wrote should not then surface in the tree
    // as though the reader had put it there. (Its `.crswap` is the swap rule.)
    if (atRoot && (name === ENTRY_STYLE_FILE || name === LEGACY_STYLE_FILE)) return true;
    if (kind === 'directory') {
        // The AI agent's folders (utils/vaultAgentStore.ts) — root-only, where the
        // agent CLIs look for them.
        if (atRoot && ROOT_HIDDEN_DIRS.has(name)) return true;
        // Every folder may hold its own pair of these (see utils/assets.ts), so
        // this is not a root-only test.
        if (name === ASSETS_DIR || name === TRASH_DIR) return true;
    }
    return false;
}

/**
 * Is the entry at `components` (vault-root-relative, its own name LAST) hidden
 * from the file tree? Looks at the entry itself only — a visible entry inside a
 * hidden folder is unreachable by the walk (it never descends), which is
 * `isIgnoredChangePath`'s concern, not this one's.
 */
export function isHiddenVaultEntry(components: readonly string[], kind: EntryKind): boolean {
    const n = components.length;
    return n > 0 && isHiddenEntryName(components[n - 1], n === 1, kind);
}

/**
 * Should an observer record at `components` be dropped without a look?
 *
 * Everything the tree hides, plus everything INSIDE a hidden folder — `.git`
 * alone is the bulk of a `git` command's noise (hundreds of object/ref/index
 * records per checkout), and `.Assets`/`.Garbage`/`.VaultAgent` churn on the
 * app's own saves.
 *
 * `kind` is the changed handle's, when the record has one. A 'disappeared'
 * record's handle may be null, and an unknown kind must err towards NOT
 * ignoring: a wrongly-ignored visible entry is a tree that silently misses a
 * change, while a wrongly-kept hidden one costs one parent-directory re-list
 * that shares back to the identical tree. So an unknown last component is only
 * tested by the rules that hold for either kind; the ancestors are directories
 * by definition.
 */
export function isIgnoredChangePath(components: readonly string[], kind?: EntryKind): boolean {
    const n = components.length;
    for (let i = 0; i < n - 1; i++) {
        if (isHiddenEntryName(components[i], i === 0, 'directory')) return true;
    }
    return n > 0 && isHiddenEntryName(components[n - 1], n === 1, kind ?? 'file');
}
