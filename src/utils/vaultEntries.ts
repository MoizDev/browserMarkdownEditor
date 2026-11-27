import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE } from './entryStyle';
import { ASSETS_DIR, TRASH_DIR } from './assets';
import { ROOT_HIDDEN_DIRS } from './vaultAgentStore';

export type EntryKind = 'file' | 'directory';

export function isGitName(name: string): boolean {
    return name === '.git';
}

function isSwapName(name: string): boolean {
    return name.endsWith('.crswap');
}

export function isHiddenEntryName(name: string, atRoot: boolean, kind: EntryKind): boolean {
    if (name === '.DS_Store') return true;
    if (isGitName(name) || isSwapName(name)) return true;
    if (name === ENTRY_STYLE_FILE || (atRoot && name === LEGACY_STYLE_FILE)) return true;
    if (kind === 'directory') {
        if (atRoot && ROOT_HIDDEN_DIRS.has(name)) return true;
        if (name === ASSETS_DIR || name === TRASH_DIR) return true;
    }
    return false;
}

export function isHiddenVaultEntry(components: readonly string[], kind: EntryKind): boolean {
    const n = components.length;
    return n > 0 && isHiddenEntryName(components[n - 1], n === 1, kind);
}

export function isIgnoredChangePath(components: readonly string[], kind?: EntryKind): boolean {
    const n = components.length;
    for (let i = 0; i < n - 1; i++) {
        if (isHiddenEntryName(components[i], i === 0, 'directory')) return true;
    }
    return n > 0 && isHiddenEntryName(components[n - 1], n === 1, kind ?? 'file');
}
