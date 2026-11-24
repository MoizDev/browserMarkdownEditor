// What a NEW system terminal window would run, and in what environment.
//
// The terminal is the user's own login shell with their whole profile (PATH,
// aliases, prompt themes, nvm/pyenv/conda …), so nothing here narrows or adds
// to it beyond what a terminal app itself does: pick the login shell, start it
// as a login shell, and hand it a sane environment. The helper's OWN environment
// is the problem to solve — under launchd/systemd/Task Scheduler it is bare
// (measured on macOS: PATH=/usr/bin:/bin:/usr/sbin:/sbin, no LANG) and carries
// service-manager residue that must not leak into the user's shell.
//
// Pure functions with injected inputs, so the table tests need no real machine.
// NEVER reuse proc.ts's `agentEnv`: it injects PATH dirs for the agent CLIs.

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { homedir, userInfo as osUserInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { HELPER_VERSION } from '../buildInfo.ts';
import { runCapture } from '../proc.ts';

export interface UserInfoLike {
    username: string;
    homedir: string;
    /** `os.userInfo().shell`: null on Windows. */
    shell: string | null;
}

export interface ShellSpec {
    file: string;
    args: string[];
    argv0?: string;
}

/**
 * TEST-ONLY. Smoke runs and the tests set this to a plain shell (`/bin/sh`,
 * `cmd.exe`): their scratch HOME has no `.zshrc`, and zsh would answer with the
 * first-run wizard instead of a prompt. It is read from the helper's own
 * environment, so it widens nothing: whoever can set it already runs code as
 * the user. It is never passed on to the shell (see STRIP_PREFIXES).
 */
export const TERMINAL_SHELL_OVERRIDE = 'VAULTAGENT_TERMINAL_SHELL';

/** `$SHELL` must be RUNNABLE, not merely present: a non-executable one would fail
 *  the spawn outright instead of falling back to the passwd entry. */
function isExecutable(path: string): boolean {
    try {
        accessSync(path, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Shells that are not shells: an account that cannot log in. */
const NOT_A_SHELL = /(^|\/)(nologin|false|true)$/;

type Exists = (path: string) => boolean;
type Env = Record<string, string | undefined>;

function isAbsolute(platform: string, p: string): boolean {
    return platform === 'win32' ? win32.isAbsolute(p) : posix.isAbsolute(p);
}

/** The shell file for a POSIX account: $SHELL, else the passwd entry, else /bin/sh. */
function posixShell(env: Env, user: UserInfoLike, exists: Exists): string {
    for (const candidate of [env.SHELL, user.shell]) {
        if (!candidate || !isAbsolute('linux', candidate) || !exists(candidate)) continue;
        // An account with /usr/bin/false or nologin still deserves a terminal: bash.
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
    // `-l`: a login shell, as every terminal app starts it. The PTY makes it
    // interactive, so zsh reads /etc/zprofile (path_helper) → ~/.zprofile (Homebrew)
    // → ~/.zshrc: that is where oh-my-zsh, starship, nvm and pyenv come from.
    return { file: posixShell(env, user, exists), args: ['-l'] };
}

/** Helper / service-manager / dev-run variables a shell must not inherit. */
const STRIP_EXACT = new Set([
    // launchd (XPC_SERVICE_NAME is reset below, not just dropped)
    'XPC_FLAGS', 'OSLogRateLimit', 'LaunchInstanceID',
    // systemd
    'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MANAGERPID', 'NOTIFY_SOCKET',
    // a helper started from inside a Claude Code session or another terminal (dev):
    // that session's ids and tokens, and the shell state a new window starts afresh
    'CLAUDECODE', 'AI_AGENT', 'INIT_CWD', 'NODE_ENV', '_', 'OLDPWD', 'SHLVL', '__CFBundleIdentifier',
]);
// VAULTAGENT_: the test override above and anything else of ours, so no helper
// setting ever reaches the user's shell.
// CLAUDE_: a Claude Code session's own settings and tokens; anything the user
// sets themselves comes back from their profile, which the login shell runs.
const STRIP_PREFIXES = ['LISTEN_', 'MEMORY_PRESSURE_', 'npm_', 'BUN_', 'VAULTAGENT_', 'CLAUDE_'];

const UTF8 = /utf-?8/i;

export interface TerminalEnvOptions {
    platform?: string;
    /** The shell that will run: becomes SHELL, as a terminal app sets it. */
    shell: string;
    /** `LANG` to use when the environment has no UTF-8 one (macOS: from the system locale). */
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
    // Set explicitly, not inherited: measured, zsh answered LOGNAME=root when it was missing.
    env.HOME = user.homedir;
    env.USER = user.username;
    env.LOGNAME = user.username;
    env.SHELL = opts.shell;
    // launchd provides no LANG, and without a UTF-8 one prompt glyphs (starship,
    // p10k) and every non-ASCII filename break.
    if (!env.LANG || !UTF8.test(env.LANG)) env.LANG = opts.locale || 'en_US.UTF-8';
    return env;
}

let localeProbe: Promise<string | null> | null = null;

/** The system locale as a LANG value (`en_US.UTF-8`), as Terminal.app derives it. macOS only. */
export function macLocale(): Promise<string | null> {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    localeProbe ??= runCapture(['defaults', 'read', '-g', 'AppleLocale'], { timeoutMs: 2000 }).then(r => {
        // `en_US`, or `en_US@rg=gbzzzz` with a region override: LANG takes only the first part.
        const locale = r.stdout.trim().split('@')[0];
        return r.code === 0 && /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(locale) ? `${locale}.UTF-8` : null;
    });
    return localeProbe;
}

export interface TerminalLaunch extends ShellSpec {
    env: Record<string, string>;
    cwd: string;
}

/** Everything `spawn` needs for a new terminal, from the real machine. */
export async function terminalLaunch(): Promise<TerminalLaunch> {
    let user: UserInfoLike;
    try {
        const u = osUserInfo();
        user = { username: u.username, homedir: u.homedir || homedir(), shell: u.shell };
    } catch {
        // os.userInfo() throws for a uid with no passwd entry (containers).
        user = { username: process.env.USER ?? process.env.USERNAME ?? 'user', homedir: homedir(), shell: null };
    }
    const spec = resolveShell(process.platform, process.env, user, process.platform === 'win32' ? existsSync : isExecutable);
    const env = terminalEnv(process.env, user, { shell: spec.file, locale: await macLocale() });
    // A new system terminal window starts in ~, wherever the helper was started.
    return { ...spec, env, cwd: user.homedir };
}
