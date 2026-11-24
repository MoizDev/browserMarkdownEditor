// `vault.sync`: copy the vault's instruction and skill files into the vault's
// working folder, so each CLI picks them up natively, as it would inside the
// vault itself.
//
// This is the only place the helper writes files a browser message chose the
// names of, so it takes nothing on trust:
//   • a fixed whitelist — CLAUDE.md, AGENTS.md, .claude/skills/**, .agents/skills/**.
//     Never a CLI config (opencode.json, .opencode/, .claude/settings*.json,
//     .mcp.json, .codex/): any of those would hand a vault the power to add
//     tools, hooks or MCP servers to the agent — code outside the vault;
//   • text only, per-file and total size caps from the protocol;
//   • every resolved path must stay under that vault's folder, and no existing
//     component on the way may be a symlink (one could point anywhere);
//   • it only ever deletes files it wrote itself (listed in .bme/mirror.json).

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MAX_MIRROR_FILE_BYTES, MAX_MIRROR_TOTAL_BYTES, type MirrorFile } from '../../shared/vaultAgentProtocol.ts';
import { BadRequest, ensureDir, isInside, vaultDir } from './paths.ts';

const MANIFEST = '.bme/mirror.json';
const MAX_FILES = 2000;
/** Names that configure a CLI (tools, hooks, MCP servers). The whitelist already keeps
 *  them out of the places a CLI reads them from; refusing them anywhere costs nothing. */
const FORBIDDEN_SEGMENTS = new Set(['opencode.json', 'opencode.jsonc', '.opencode', '.mcp.json', '.codex']);

/** Validates a vault-relative mirror path; returns its `/`-separated segments. */
export function checkMirrorPath(path: unknown): string[] {
    if (typeof path !== 'string' || !path || path.length > 512) throw new BadRequest('mirror path must be a non-empty string');
    if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new BadRequest(`mirror path not allowed: ${path}`);
    const segs = path.split('/');
    if (segs.some(s => s === '' || s === '.' || s === '..')) throw new BadRequest(`mirror path not allowed: ${path}`);
    // Windows would silently strip these, turning `CLAUDE.md.` into `CLAUDE.md` after the check.
    if (segs.some(s => /[. ]$/.test(s) || /[<>:"|?*]/.test(s) || [...s].some(ch => ch.charCodeAt(0) < 32))) throw new BadRequest(`mirror path not allowed: ${path}`);
    if (segs.some(s => FORBIDDEN_SEGMENTS.has(s.toLowerCase()))) throw new BadRequest(`mirror path not allowed: ${path}`);
    const top = segs.length === 1 && (segs[0] === 'CLAUDE.md' || segs[0] === 'AGENTS.md');
    const skill = segs.length >= 3 && (segs[0] === '.claude' || segs[0] === '.agents') && segs[1] === 'skills';
    if (!top && !skill) throw new BadRequest(`only CLAUDE.md, AGENTS.md, .claude/skills/** and .agents/skills/** are mirrored: ${path}`);
    return segs;
}

/** Refuses when any existing component between `root` and `target` is not a plain directory/file. */
function assertNoSymlinks(root: string, segs: string[]): void {
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
        cur = join(cur, segs[i]);
        let st;
        try {
            st = lstatSync(cur);
        } catch {
            return; // nothing further exists yet; mkdir/write create real entries
        }
        if (st.isSymbolicLink()) throw new BadRequest(`mirror path crosses a symlink: ${segs.slice(0, i + 1).join('/')}`);
        if (i < segs.length - 1 && !st.isDirectory()) throw new BadRequest(`mirror path crosses a file: ${segs.slice(0, i + 1).join('/')}`);
    }
}

function readManifest(root: string): string[] {
    try {
        const data = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
        return Array.isArray(data?.files) ? data.files.filter((f: unknown): f is string => typeof f === 'string') : [];
    } catch {
        return [];
    }
}

function writeAtomic(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
}

/** Remove now-empty folders above a deleted file, never climbing out of the skill roots. */
function pruneEmptyDirs(root: string, segs: string[]): void {
    for (let i = segs.length - 1; i >= 3; i--) {
        const dir = join(root, ...segs.slice(0, i));
        try {
            if (readdirSync(dir).length) return;
            rmdirSync(dir);
        } catch {
            return;
        }
    }
}

export interface SyncResult { written: number; removed: number }

export function syncMirror(sessionsRoot: string, vaultId: unknown, files: unknown): SyncResult {
    const root = vaultDir(sessionsRoot, vaultId);
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new BadRequest('files must be an array');

    const planned = new Map<string, { segs: string[]; text: string }>();
    let total = 0;
    for (const f of files as MirrorFile[]) {
        if (!f || typeof f !== 'object' || typeof f.text !== 'string') throw new BadRequest('each file needs a path and text');
        const segs = checkMirrorPath(f.path);
        if (planned.has(f.path)) throw new BadRequest(`duplicate mirror path: ${f.path}`);
        if (f.text.includes('\0')) throw new BadRequest(`not a text file: ${f.path}`);
        const bytes = Buffer.byteLength(f.text, 'utf8');
        if (bytes > MAX_MIRROR_FILE_BYTES) throw new BadRequest(`too large to mirror: ${f.path}`);
        total += bytes;
        if (total > MAX_MIRROR_TOTAL_BYTES) throw new BadRequest('mirrored files exceed the total size cap');
        planned.set(f.path, { segs, text: f.text });
    }

    ensureDir(root);
    // Validate everything before touching anything, so a bad entry leaves the old mirror intact.
    for (const { segs } of planned.values()) {
        assertNoSymlinks(root, segs);
        if (!isInside(root, resolve(root, ...segs))) throw new BadRequest('mirror path escapes the vault folder');
    }

    let written = 0;
    for (const { segs, text } of planned.values()) {
        const target = resolve(root, ...segs);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        assertNoSymlinks(root, segs); // again: mkdir may have raced a swap
        let same = false;
        try {
            same = readFileSync(target, 'utf8') === text;
        } catch { /* new file */ }
        if (!same) {
            writeAtomic(target, text);
            written++;
        }
    }

    let removed = 0;
    // macOS and Windows file systems ignore case: after a case-only rename in
    // the vault (skills/a → skills/A) the old entry IS the file just written,
    // and unlinking it emptied the skill until the next sync.
    const foldCase = process.platform === 'darwin' || process.platform === 'win32';
    const plannedFolded = new Set([...planned.keys()].map(k => k.toLowerCase()));
    for (const old of readManifest(root)) {
        if (planned.has(old) || (foldCase && plannedFolded.has(old.toLowerCase()))) continue;
        let segs: string[];
        try {
            segs = checkMirrorPath(old);
            assertNoSymlinks(root, segs);
        } catch {
            continue; // a manifest entry we would not have written: leave it alone
        }
        const target = resolve(root, ...segs);
        if (!isInside(root, target) || !existsSync(target)) continue;
        try {
            unlinkSync(target);
            removed++;
            pruneEmptyDirs(root, segs);
        } catch { /* already gone */ }
    }

    ensureDir(join(root, '.bme'));
    writeAtomic(join(root, MANIFEST), JSON.stringify({ version: 1, files: [...planned.keys()].sort() }, null, 1));
    return { written, removed };
}
