import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isUuid } from '../../shared/vaultAgentProtocol.ts';
import { ensureDir, isInside, sessionsRootFor } from './paths.ts';
import { logError } from './log.ts';

const MAX_DEPTH = 6;
const BUDGET_MS = 2_000;
const MAX_DIRS = 20_000;

const SKIP = new Set([
    'node_modules', 'Library', 'Applications', '.git', '.Trash', '.cache', '.npm', '.nvm',
    'venv', '.venv', '__pycache__', 'target', 'dist', 'build', '.next', 'vendor',
    'Pictures', 'Music', 'Movies', '.bme-agent-sessions',
]);

const MARKER = join('.VaultAgent', 'vault.json');

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
        logError('vault-path cache', err);
    }
}

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
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                const name = entry.name;
                if (name.startsWith('.') || SKIP.has(name)) continue;
                next.push({ dir: join(dir, name), depth: depth + 1 });
            }
        }
        queue = next;
    }
    return null;
}

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
        const { [vaultId.toLowerCase()]: _gone, ...rest } = cache;
        writeCache(home, rest);
    }
    return null;
}

export function rememberVaultPath(vaultId: unknown, path: unknown, home: string = homedir()): string | null {
    if (!isUuid(vaultId) || typeof path !== 'string' || !path.trim()) return null;
    const resolved = resolve(path.replace(/^~(?=\/|$)/, home));
    if (!isVaultRoot(resolved, vaultId)) return null;
    writeCache(home, { ...readCache(home), [vaultId.toLowerCase()]: resolved });
    return resolved;
}

export function terminalCwdFor(vaultId: unknown, dir: unknown, home: string = homedir()): string | null {
    if (typeof vaultId !== 'string' || !isUuid(vaultId)) return null;
    const root = locateVault(vaultId, home);
    if (!root) return null;
    if (typeof dir !== 'string' || !dir || dir === '.') return root;
    if (dir.includes('\0') || dir.split('/').some(part => part === '..')) return root;
    const target = resolve(root, dir);
    if (!isInside(root, target)) return root;
    try {
        return statSync(target).isDirectory() ? target : root;
    } catch {
        return root;
    }
}
