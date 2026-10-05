// Where a vault actually lives on disk — the one thing the browser cannot tell
// us, and the terminal needs.
//
// WHY THIS EXISTS. A new terminal should open in the folder of the file the user
// is looking at. The editor knows that file as `CS145/sum.rkt`, vault-relative,
// because the File System Access API hands out handles and never a path: Chrome
// will not say `/Users/…`. The helper is a separate process and has never been
// told either — the agent CLIs run in `~/.bme-agent-sessions/<uuid>` precisely
// because nothing here knows the vault's real location.
//
// HOW IT IS FOUND. The editor writes `.VaultAgent/vault.json` at the vault root,
// holding that vault's UUID — so the question "where is vault X?" has an exact
// answer on disk, and a search for it cannot be fooled by a folder that merely
// has the right name. The walk below looks for that marker, breadth-first from
// the home directory, and the answer is remembered so the next terminal is
// instant.
//
// WHAT IT WILL NOT DO. It does not read a single file of the user's content: at
// each directory it asks one question — "is there a `.VaultAgent/vault.json`
// here, and is it this vault's?" — and the only file it ever opens is that
// marker. It stays inside the home directory, skips the places a vault is not
// (`Library`, `node_modules`, `.git`, the Trash), never follows a symlink out,
// and gives up on a budget rather than grinding. A vault on a network share or
// outside $HOME simply is not found, which is what the typed path in Settings
// is for.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isUuid } from '../../shared/vaultAgentProtocol.ts';
import { ensureDir, isInside, sessionsRootFor } from './paths.ts';
import { logError } from './log.ts';

/** How deep below home a vault is looked for. `~/a/b/c/d/e/vault` is depth 6;
 *  deeper than that and the typed path is the better answer anyway. */
const MAX_DEPTH = 6;
/** The walk stops here however much is left — a terminal must open promptly. */
const BUDGET_MS = 2_000;
/** And here, for a home directory with an enormous tree in it. */
const MAX_DIRS = 20_000;

/** Folders a vault is never in, and which are expensive to walk. */
const SKIP = new Set([
    'node_modules', 'Library', 'Applications', '.git', '.Trash', '.cache', '.npm', '.nvm',
    'venv', '.venv', '__pycache__', 'target', 'dist', 'build', '.next', 'vendor',
    'Pictures', 'Music', 'Movies', '.bme-agent-sessions',
]);

/** The marker the editor writes at a vault's root (utils/vaultAgentStore.ts). */
const MARKER = join('.VaultAgent', 'vault.json');

/** Remembered answers, so the search happens once per vault per machine. */
function cacheFile(home: string): string {
    return join(sessionsRootFor(home), 'vault-paths.json');
}

function readCache(home: string): Record<string, string> {
    try {
        const raw = JSON.parse(readFileSync(cacheFile(home), 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object') return {};
        const out: Record<string, string> = {};
        for (const [id, path] of Object.entries(raw as Record<string, unknown>)) {
            if (isUuid(id) && typeof path === 'string') out[id] = path;
        }
        return out;
    } catch {
        return {};
    }
}

function writeCache(home: string, cache: Record<string, string>): void {
    try {
        ensureDir(sessionsRootFor(home));
        writeFileSync(cacheFile(home), JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch (err) {
        // A cache that cannot be written costs a search next time, nothing more.
        logError('vault-path cache', err);
    }
}

/** Is `dir` the root of the vault with this id? The marker decides, not the name. */
export function isVaultRoot(dir: string, vaultId: string): boolean {
    try {
        const marker = join(dir, MARKER);
        if (!existsSync(marker)) return false;
        const parsed = JSON.parse(readFileSync(marker, 'utf8')) as unknown;
        const id = (parsed as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id.toLowerCase() === vaultId.toLowerCase();
    } catch {
        return false;
    }
}

export interface SearchLimits {
    maxDepth?: number;
    budgetMs?: number;
    maxDirs?: number;
    now?: () => number;
}

/**
 * Breadth-first from `root`, looking for the vault's marker.
 *
 * Breadth-first on purpose: a vault is usually one or two folders down
 * (`~/Documents/Notes`), and depth-first would spend the budget inside the
 * first deep tree it met.
 */
export function searchForVault(root: string, vaultId: string, limits: SearchLimits = {}): string | null {
    const { maxDepth = MAX_DEPTH, budgetMs = BUDGET_MS, maxDirs = MAX_DIRS, now = Date.now } = limits;
    const deadline = now() + budgetMs;
    let queue: Array<{ dir: string; depth: number }> = [{ dir: resolve(root), depth: 0 }];
    let seen = 0;

    while (queue.length) {
        const next: Array<{ dir: string; depth: number }> = [];
        for (const { dir, depth } of queue) {
            if (++seen > maxDirs || now() > deadline) return null;
            if (isVaultRoot(dir, vaultId)) return dir;
            if (depth >= maxDepth) continue;
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;   // unreadable (permissions, a vanished folder)
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                const name = entry.name;
                // Hidden folders are skipped — `.VaultAgent` is looked for by
                // name above, never walked into.
                if (name.startsWith('.') || SKIP.has(name)) continue;
                next.push({ dir: join(dir, name), depth: depth + 1 });
            }
        }
        queue = next;
    }
    return null;
}

/**
 * The vault's folder, or null.
 *
 * Cache first, and the cached answer is re-checked against the marker every
 * time: a vault that was moved or renamed must not hand a terminal somebody
 * else's directory.
 */
export function locateVault(vaultId: unknown, home: string = homedir()): string | null {
    if (!isUuid(vaultId)) return null;
    const cache = readCache(home);
    const remembered = cache[vaultId.toLowerCase()];
    if (remembered && isVaultRoot(remembered, vaultId)) return remembered;

    const found = searchForVault(home, vaultId);
    if (found) {
        writeCache(home, { ...cache, [vaultId.toLowerCase()]: found });
        return found;
    }
    if (remembered) {
        // It was known and is now wrong: forget it rather than keep answering
        // with a folder that is no longer that vault.
        const { [vaultId.toLowerCase()]: _gone, ...rest } = cache;
        writeCache(home, rest);
    }
    return null;
}

/** What Settings offers when the search comes up empty: the user's own path.
 *  Checked against the marker, so a typo cannot point a shell anywhere odd. */
export function rememberVaultPath(vaultId: unknown, path: unknown, home: string = homedir()): string | null {
    if (!isUuid(vaultId) || typeof path !== 'string' || !path.trim()) return null;
    const resolved = resolve(path.replace(/^~(?=\/|$)/, home));
    if (!isVaultRoot(resolved, vaultId)) return null;
    writeCache(home, { ...readCache(home), [vaultId.toLowerCase()]: resolved });
    return resolved;
}

/**
 * Where a terminal for `dir` (vault-relative, from the editor) should start.
 *
 * Falls back along the way rather than failing: an unknown vault, a folder that
 * has been deleted since the editor last saw it, or anything that resolves
 * outside the vault all end at the vault root, and a vault that cannot be found
 * at all ends at null — which the caller reads as "the home directory", the
 * behaviour before any of this existed.
 */
export function terminalCwdFor(vaultId: unknown, dir: unknown, home: string = homedir()): string | null {
    if (typeof vaultId !== 'string' || !isUuid(vaultId)) return null;
    const root = locateVault(vaultId, home);
    if (!root) return null;
    if (typeof dir !== 'string' || !dir || dir === '.') return root;
    // The editor's paths are `/`-separated and vault-relative; anything with a
    // `..`, an absolute form or a NUL is not from the editor.
    if (dir.includes('\0') || dir.split('/').some(part => part === '..')) return root;
    const target = resolve(root, dir);
    if (!isInside(root, target)) return root;
    try {
        return statSync(target).isDirectory() ? target : root;
    } catch {
        return root;
    }
}
