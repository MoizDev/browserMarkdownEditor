// Finding the agent CLIs. The helper runs under launchd / Task Scheduler /
// systemd, which give it no login-shell PATH, so `claude` et al. are looked up
// in the places their installers actually use, then (POSIX) once through the
// user's login shell as a last resort.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import type { AgentId } from '../../../shared/vaultAgentProtocol.ts';
import { runCapture } from '../proc.ts';

export interface FoundBinary {
    /** What to spawn: the binary itself, or [node, script] for an npm `.cmd` shim on Windows. */
    command: string[];
    /** The resolved file (for display and for PATH). */
    path: string;
    /** Folders to put first on the child's PATH (the CLI's own, node's). */
    pathDirs: string[];
}

const IS_WIN = process.platform === 'win32';

function isExecutable(p: string): boolean {
    try {
        const st = statSync(p);
        return st.isFile() && (IS_WIN || (st.mode & 0o111) !== 0);
    } catch {
        return false;
    }
}

function nvmBins(home: string): string[] {
    const root = join(home, '.nvm', 'versions', 'node');
    try {
        // Newest first: nvm's `default` alias is usually the newest install.
        return readdirSync(root)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map(v => join(root, v, 'bin'));
    } catch {
        return [];
    }
}

/** Candidate folders, most specific first. Exported for tests. */
export function candidateDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
    const pathDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
    if (IS_WIN) {
        const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
        const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
        return [
            join(home, '.local', 'bin'),                 // Claude Code native installer
            join(home, '.opencode', 'bin'),              // OpenCode install script
            join(appData, 'npm'),                        // npm -g
            join(local, 'Microsoft', 'WinGet', 'Links'),
            join(home, 'scoop', 'shims'),
            join(local, 'Programs', 'opencode'),
            join(home, '.bun', 'bin'),
            join(local, 'Volta', 'bin'),
            ...pathDirs,
        ];
    }
    return [
        join(home, '.local', 'bin'),        // Claude Code native installer, pipx-style installs
        join(home, '.claude', 'local'),     // older Claude Code "local" installs
        join(home, '.opencode', 'bin'),     // OpenCode install script
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(home, '.bun', 'bin'),
        join(home, '.npm-global', 'bin'),
        join(home, '.volta', 'bin'),
        join(home, '.local', 'share', 'pnpm'),
        join(home, 'Library', 'pnpm'),
        join(home, '.yarn', 'bin'),
        join(home, '.asdf', 'shims'),
        join(home, '.local', 'share', 'mise', 'shims'),
        ...nvmBins(home),
        '/snap/bin',
        '/usr/bin',
        ...pathDirs,
    ];
}

function names(agent: AgentId): string[] {
    return IS_WIN ? [`${agent}.exe`, `${agent}.cmd`] : [agent];
}

/**
 * npm on Windows installs `x.cmd` shims, which can only run through cmd.exe —
 * and passing arguments through cmd.exe is exactly the shell parsing we refuse.
 * The shim names the script it runs; we run that script with node directly.
 */
export function resolveCmdShim(shimPath: string, shimText: string, nodePath: string | null): string[] | null {
    // Current `claude` and `opencode-ai` ship a native exe behind the shim: run it directly.
    const exe = /"%(?:~?dp0)%\\([^"]+\.exe)"/i.exec(shimText);
    if (exe) return [join(dirname(shimPath), exe[1])];
    const m = /"%(?:~?dp0)%\\([^"]+\.(?:js|cjs|mjs))"/i.exec(shimText);
    if (!m || !nodePath) return null;
    return [nodePath, join(dirname(shimPath), m[1])];
}

let nodeCache: string | null | undefined;
function findNode(): string | null {
    if (nodeCache !== undefined) return nodeCache;
    for (const dir of candidateDirs()) {
        const p = join(dir, IS_WIN ? 'node.exe' : 'node');
        if (isExecutable(p)) return (nodeCache = p);
    }
    return (nodeCache = null);
}

async function viaLoginShell(agent: AgentId): Promise<string | null> {
    if (IS_WIN) {
        const r = await runCapture(['where.exe', agent], { timeoutMs: 5000 });
        const line = r.stdout.split(/\r?\n/).map(s => s.trim()).find(s => /\.(exe|cmd)$/i.test(s));
        return line ?? null;
    }
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
    // `agent` is one of three fixed literals, never panel input.
    const r = await runCapture([shell, '-lic', `command -v ${agent}`], { timeoutMs: 5000 });
    const line = r.stdout.split('\n').map(s => s.trim()).reverse().find(s => s.startsWith('/'));
    return line && isExecutable(line) ? line : null;
}

function describe(path: string): FoundBinary | null {
    const node = findNode();
    const pathDirs = [dirname(path), ...(node ? [dirname(node)] : [])];
    if (IS_WIN && /\.cmd$/i.test(path)) {
        let text = '';
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            return null;
        }
        const command = resolveCmdShim(path, text, node);
        return command ? { command, path, pathDirs } : null;
    }
    return { command: [path], path, pathDirs };
}

const cache = new Map<AgentId, { at: number; found: FoundBinary | null }>();
const CACHE_MS = 60_000;

export async function findAgentBinary(agent: AgentId, refresh = false): Promise<FoundBinary | null> {
    const hit = cache.get(agent);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.found;
    let found: FoundBinary | null = null;
    for (const dir of candidateDirs()) {
        for (const name of names(agent)) {
            const p = join(dir, name);
            if (isExecutable(p)) {
                found = describe(p);
                if (found) break;
            }
        }
        if (found) break;
    }
    if (!found) {
        const p = await viaLoginShell(agent);
        if (p && basename(p).toLowerCase().startsWith(agent)) found = describe(p);
    }
    cache.set(agent, { at: Date.now(), found });
    return found;
}

/** First `x.y.z` in `<bin> --version`. */
export function parseVersion(text: string): string | null {
    return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}
