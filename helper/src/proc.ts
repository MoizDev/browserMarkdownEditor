// Spawning the agent CLIs. Argument arrays only — never a shell string — so no
// value from the panel (a model name, a session id) can ever be parsed as a
// command. Values that do reach argv are validated by their adapter first.

import { delimiter } from 'node:path';
import { homedir } from 'node:os';
import type { Subprocess } from 'bun';

export interface SpawnSpec {
    cmd: string[];
    cwd: string;
    env: Record<string, string>;
}

/**
 * The environment every CLI gets. launchd / Task Scheduler / systemd start the
 * helper with a bare environment (no shell PATH, sometimes no HOME), so we set
 * HOME/USERPROFILE and a PATH that has the CLI's own folder and node's folder
 * first (npm-installed CLIs are `#!/usr/bin/env node` scripts).
 */
export function agentEnv(extraPathDirs: string[], overrides: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const home = homedir();
    env.HOME ??= home;
    if (process.platform === 'win32') env.USERPROFILE ??= home;
    const seen = new Set<string>();
    const dirs = [...extraPathDirs, ...(env.PATH ?? env.Path ?? '').split(delimiter), ...defaultPathDirs()].filter(d => {
        if (!d || seen.has(d)) return false;
        seen.add(d);
        return true;
    });
    env.PATH = dirs.join(delimiter);
    if (process.platform === 'win32') delete env.Path;
    env.LANG ??= 'en_US.UTF-8';
    // A helper started from inside a Claude Code session (dev) must not make
    // the child think it is a nested Claude Code subprocess.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
    }
    return env;
}

function defaultPathDirs(): string[] {
    if (process.platform === 'win32') return [];
    return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : [])];
}

/** Run to completion with a timeout; stdout/stderr as text. Never throws. */
export async function runCapture(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string } = {}):
    Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    let proc: Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
        proc = Bun.spawn(cmd, {
            cwd: opts.cwd,
            env: opts.env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });
    } catch (e) {
        return { code: null, stdout: '', stderr: e instanceof Error ? e.message : '', timedOut: false };
    }
    if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
    proc.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killHard(proc);
    }, opts.timeoutMs ?? 15_000);
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timer);
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
}

export function killHard(proc: Subprocess): void {
    try {
        proc.kill('SIGKILL');
    } catch { /* already gone */ }
}

/**
 * SIGTERM, then SIGKILL after `graceMs`. Measured: `opencode serve` and
 * `codex app-server` both outlive a plain SIGTERM for seconds, holding their
 * port and DB handles, so a hard stop always follows.
 */
export function stopProcess(proc: Subprocess, graceMs = 2000): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    try {
        proc.kill('SIGTERM');
    } catch { /* gone */ }
    const t = setTimeout(() => killHard(proc), graceMs);
    return proc.exited.then(() => clearTimeout(t), () => clearTimeout(t));
}

/** Splits a byte stream into lines (LF, tolerating CRLF). */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line) yield line;
        }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf.replace(/\r$/, '');
}

/** Drains a stream, keeping only the tail (for exit diagnostics that are never logged). */
export async function drainTail(stream: ReadableStream<Uint8Array>, max = 4000): Promise<string> {
    const decoder = new TextDecoder();
    let tail = '';
    for await (const chunk of stream) {
        tail += decoder.decode(chunk, { stream: true });
        if (tail.length > max * 2) tail = tail.slice(-max);
    }
    return tail.slice(-max);
}
