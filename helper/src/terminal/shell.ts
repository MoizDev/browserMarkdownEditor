// NEVER reuse proc.ts's `agentEnv`: it injects PATH dirs for the agent CLIs.

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { homedir, userInfo as osUserInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { HELPER_VERSION } from '../buildInfo.ts';
import { runCapture } from '../proc.ts';

export interface UserInfoLike {
    username: string;
    homedir: string;
    shell: string | null;
}

export interface ShellSpec {
    file: string;
    args: string[];
    argv0?: string;
}

export const TERMINAL_SHELL_OVERRIDE = 'VAULTAGENT_TERMINAL_SHELL';

function isExecutable(path: string): boolean {
    try {
        accessSync(path, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

const NOT_A_SHELL = /(^|\/)(nologin|false|true)$/;

type Exists = (path: string) => boolean;
type Env = Record<string, string | undefined>;

function isAbsolute(platform: string, p: string): boolean {
    return platform === 'win32' ? win32.isAbsolute(p) : posix.isAbsolute(p);
}

function posixShell(env: Env, user: UserInfoLike, exists: Exists): string {
    for (const candidate of [env.SHELL, user.shell]) {
        if (!candidate || !isAbsolute('linux', candidate) || !exists(candidate)) continue;
        if (NOT_A_SHELL.test(candidate)) return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
        return candidate;
    }
    return '/bin/sh';
}

function windowsShell(env: Env, exists: Exists): ShellSpec {
    const get = (k: string) => env[k] ?? env[k.toUpperCase()] ?? env[k.toLowerCase()];
    const candidates: string[] = [];
    for (const dir of (get('Path') ?? get('PATH') ?? '').split(';').filter(Boolean)) candidates.push(win32.join(dir, 'pwsh.exe'));
    for (const base of [get('ProgramFiles'), 'C:\\Program Files']) {
        if (base) candidates.push(win32.join(base, 'PowerShell', '7', 'pwsh.exe'));
    }
    const pwsh = candidates.find(exists);
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    const system = get('SystemRoot') ?? 'C:\\Windows';
    const powershell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(powershell)) return { file: powershell, args: ['-NoLogo'] };
    return { file: get('ComSpec') ?? win32.join(system, 'System32', 'cmd.exe'), args: [] };
}

export function resolveShell(platform: string, env: Env, user: UserInfoLike, exists: Exists): ShellSpec {
    const override = env[TERMINAL_SHELL_OVERRIDE];
    if (override && isAbsolute(platform, override) && exists(override)) return { file: override, args: [] };
    if (platform === 'win32') return windowsShell(env, exists);
    return { file: posixShell(env, user, exists), args: ['-l'] };
}

const STRIP_EXACT = new Set([
    'XPC_FLAGS', 'OSLogRateLimit', 'LaunchInstanceID',
    'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MANAGERPID', 'NOTIFY_SOCKET',
    'CLAUDECODE', 'AI_AGENT', 'INIT_CWD', 'NODE_ENV', '_', 'OLDPWD', 'SHLVL', '__CFBundleIdentifier',
]);
const STRIP_PREFIXES = ['LISTEN_', 'MEMORY_PRESSURE_', 'npm_', 'BUN_', 'VAULTAGENT_', 'CLAUDE_'];

const UTF8 = /utf-?8/i;

export interface TerminalEnvOptions {
    platform?: string;
    shell: string;
    locale?: string | null;
    version?: string;
}

export function terminalEnv(base: Env, user: UserInfoLike, opts: TerminalEnvOptions): Record<string, string> {
    const platform = opts.platform ?? process.platform;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
        if (v === undefined || STRIP_EXACT.has(k) || STRIP_PREFIXES.some(p => k.startsWith(p))) continue;
        env[k] = v;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'VaultAgent';
    env.TERM_PROGRAM_VERSION = opts.version ?? HELPER_VERSION;
    if (platform === 'win32') return env;
    // launchd's own value names the helper's job, and update.ts reads
    // XPC_SERVICE_NAME to tell "I am the launchd job": a shell must not inherit
    // that. Terminal.app sets 0.
    if (platform === 'darwin') env.XPC_SERVICE_NAME = '0';
    env.HOME = user.homedir;
    env.USER = user.username;
    env.LOGNAME = user.username;
    env.SHELL = opts.shell;
    if (!env.LANG || !UTF8.test(env.LANG)) env.LANG = opts.locale || 'en_US.UTF-8';
    return env;
}

let localeProbe: Promise<string | null> | null = null;

export function macLocale(): Promise<string | null> {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    localeProbe ??= runCapture(['defaults', 'read', '-g', 'AppleLocale'], { timeoutMs: 2000 }).then(r => {
        const locale = r.stdout.trim().split('@')[0];
        return r.code === 0 && /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(locale) ? `${locale}.UTF-8` : null;
    });
    return localeProbe;
}

export interface TerminalLaunch extends ShellSpec {
    env: Record<string, string>;
    cwd: string;
}

export async function terminalLaunch(): Promise<TerminalLaunch> {
    let user: UserInfoLike;
    try {
        const u = osUserInfo();
        user = { username: u.username, homedir: u.homedir || homedir(), shell: u.shell };
    } catch {
        user = { username: process.env.USER ?? process.env.USERNAME ?? 'user', homedir: homedir(), shell: null };
    }
    const spec = resolveShell(process.platform, process.env, user, process.platform === 'win32' ? existsSync : isExecutable);
    const env = terminalEnv(process.env, user, { shell: spec.file, locale: await macLocale() });
    return { ...spec, env, cwd: user.homedir };
}
