// The terminal: which shell and environment a new window gets, the font hints,
// the session manager (against a fake PTY), the backend choice, and one real PTY.
// The macOS PTY-host tests live in ptyhost.test.ts.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    MAX_TERMINALS, TERMINAL_ACK_HIGH, TERMINAL_DETACHED_TTL_MS, TERMINAL_INPUT_MAX_CHARS, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS,
    type HelperMessage,
} from '../../shared/vaultAgentProtocol.ts';
import type { InstallLayout } from '../src/install/layout.ts';
import { setLogFile } from '../src/log.ts';
import { BadRequest } from '../src/paths.ts';
import { chooseBackend, inProcessBackend, type BackendDeps } from '../src/terminal/backend.ts';
import {
    collectFontHints, parseAlacritty, parseGhostty, parseIterm2, parseJsonc, parseKitty, parsePlist, parseTerminalAppFont,
    parseVscode, parseWezterm, parseWindowsTerminal, realFontHintDeps, terminalAppFontData, type FontHintDeps,
} from '../src/terminal/font.ts';
import { TerminalLimit, TerminalManager, TerminalNotFound, type Timers } from '../src/terminal/manager.ts';
import { fullDiskAccess, interpretProbeExit } from '../src/terminal/privacy.ts';
import { resolveShell, terminalEnv, terminalLaunch, TERMINAL_SHELL_OVERRIDE, type UserInfoLike } from '../src/terminal/shell.ts';
import type { PtyBackend } from '../src/terminal/types.ts';
import { fakeBackend } from './fixtures/fakePty.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'terminal-fonts', name), 'utf8');

/* ───────────────────────── shell + env ───────────────────────── */

const USER: UserInfoLike = { username: 'ada', homedir: '/Users/ada', shell: '/bin/zsh' };
const present = (...paths: string[]) => (p: string) => paths.includes(p);

describe('resolveShell', () => {
    test('POSIX: $SHELL, else the passwd shell, else /bin/sh — always a login shell', () => {
        expect(resolveShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, USER, present('/opt/homebrew/bin/fish', '/bin/zsh')))
            .toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
        expect(resolveShell('darwin', {}, USER, present('/bin/zsh'))).toEqual({ file: '/bin/zsh', args: ['-l'] });
        // $SHELL names something that is not there: the account's shell.
        expect(resolveShell('linux', { SHELL: '/gone/zsh' }, USER, present('/bin/zsh'))).toEqual({ file: '/bin/zsh', args: ['-l'] });
        expect(resolveShell('linux', {}, { ...USER, shell: null }, present())).toEqual({ file: '/bin/sh', args: ['-l'] });
        // Never a relative name from the environment.
        expect(resolveShell('linux', { SHELL: 'zsh' }, USER, present('zsh', '/bin/zsh')).file).toBe('/bin/zsh');
    });

    test('an account that cannot log in still gets bash (or sh)', () => {
        for (const shell of ['/usr/bin/false', '/usr/sbin/nologin', '/sbin/nologin', '/bin/false']) {
            expect(resolveShell('linux', {}, { ...USER, shell }, present(shell, '/bin/bash')).file).toBe('/bin/bash');
            expect(resolveShell('linux', {}, { ...USER, shell }, present(shell)).file).toBe('/bin/sh');
        }
    });

    test('Windows: pwsh on PATH, then the standard pwsh dir, then Windows PowerShell, then COMSPEC; no -Login', () => {
        const onPath = 'C:\\Tools\\pwsh.exe';
        expect(resolveShell('win32', { Path: 'C:\\Windows;C:\\Tools' }, USER, present(onPath))).toEqual({ file: onPath, args: ['-NoLogo'] });
        const std = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
        expect(resolveShell('win32', { Path: 'C:\\Windows' }, USER, present(std))).toEqual({ file: std, args: ['-NoLogo'] });
        const wps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        expect(resolveShell('win32', { SystemRoot: 'C:\\Windows' }, USER, present(wps))).toEqual({ file: wps, args: ['-NoLogo'] });
        expect(resolveShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, USER, present())).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] });
    });

    test('the test-only override wins, as a plain non-login shell; a bogus one is ignored', () => {
        expect(resolveShell('darwin', { [TERMINAL_SHELL_OVERRIDE]: '/bin/sh', SHELL: '/bin/zsh' }, USER, present('/bin/sh', '/bin/zsh'))).toEqual({ file: '/bin/sh', args: [] });
        expect(resolveShell('win32', { [TERMINAL_SHELL_OVERRIDE]: 'C:\\Windows\\System32\\cmd.exe' }, USER, present('C:\\Windows\\System32\\cmd.exe'))).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] });
        expect(resolveShell('darwin', { [TERMINAL_SHELL_OVERRIDE]: 'sh', SHELL: '/bin/zsh' }, USER, present('sh', '/bin/zsh')).file).toBe('/bin/zsh');
        expect(resolveShell('darwin', { [TERMINAL_SHELL_OVERRIDE]: '/missing/sh', SHELL: '/bin/zsh' }, USER, present('/bin/zsh')).file).toBe('/bin/zsh');
    });
});

describe('terminalEnv', () => {
    const launchd = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', HOME: '/var/root', USER: 'root', LOGNAME: 'root', TMPDIR: '/var/folders/x/T/',
        SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners', XPC_SERVICE_NAME: 'dev.bme.vaultagent', XPC_FLAGS: '0x0', OSLogRateLimit: '64',
        LaunchInstanceID: 'ABC',
    };
    const opts = { platform: 'darwin', shell: '/bin/zsh', version: '9.9.9', locale: 'en_GB.UTF-8' };

    test('strips launchd, systemd and dev-run residue, keeps the rest', () => {
        const env = terminalEnv({
            ...launchd, INVOCATION_ID: 'i', JOURNAL_STREAM: '8:1', SYSTEMD_EXEC_PID: '1', MANAGERPID: '1', LISTEN_PID: '1', LISTEN_FDS: '1', NOTIFY_SOCKET: '/run/n',
            MEMORY_PRESSURE_WATCH: '/x', MEMORY_PRESSURE_WRITE: 'y', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', npm_config_user_agent: 'npm', npm_lifecycle_event: 'x',
            INIT_CWD: '/repo', BUN_INSTALL: '/b', BUN_CONFIG_X: '1', NODE_ENV: 'development', _: '/usr/bin/bun', [TERMINAL_SHELL_OVERRIDE]: '/bin/sh', VAULTAGENT_OTHER: 'x',
            DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', XDG_RUNTIME_DIR: '/run/user/1000', EDITOR: 'vim', SOMETHING_UNSET: undefined,
        }, USER, opts);
        for (const gone of [
            'XPC_FLAGS', 'OSLogRateLimit', 'LaunchInstanceID', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MANAGERPID', 'LISTEN_PID', 'LISTEN_FDS', 'NOTIFY_SOCKET',
            'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'npm_config_user_agent', 'npm_lifecycle_event', 'INIT_CWD', 'BUN_INSTALL',
            'BUN_CONFIG_X', 'NODE_ENV', '_', TERMINAL_SHELL_OVERRIDE, 'VAULTAGENT_OTHER', 'SOMETHING_UNSET',
        ]) expect(env).not.toHaveProperty(gone);
        for (const kept of ['PATH', 'TMPDIR', 'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'EDITOR']) expect(env).toHaveProperty(kept);
    });

    test('identity and terminal variables', () => {
        const env = terminalEnv(launchd, USER, opts);
        // Not launchd's job name (update.ts reads it), and not root's identity.
        expect(env).toMatchObject({
            XPC_SERVICE_NAME: '0', HOME: '/Users/ada', USER: 'ada', LOGNAME: 'ada', SHELL: '/bin/zsh',
            TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'VaultAgent', TERM_PROGRAM_VERSION: '9.9.9',
        });
        expect(terminalEnv({}, USER, { ...opts, shell: '/bin/bash' }).SHELL).toBe('/bin/bash');
        expect(terminalEnv({}, USER, { platform: 'linux', shell: '/bin/sh' })).not.toHaveProperty('XPC_SERVICE_NAME');
    });

    test('LANG only when unset or not UTF-8', () => {
        expect(terminalEnv({}, USER, opts).LANG).toBe('en_GB.UTF-8');
        expect(terminalEnv({ LANG: 'C' }, USER, opts).LANG).toBe('en_GB.UTF-8');
        expect(terminalEnv({ LANG: 'en_US.ISO8859-1' }, USER, opts).LANG).toBe('en_GB.UTF-8');
        expect(terminalEnv({ LANG: '' }, USER, opts).LANG).toBe('en_GB.UTF-8');
        expect(terminalEnv({ LANG: 'de_DE.UTF-8' }, USER, opts).LANG).toBe('de_DE.UTF-8');
        expect(terminalEnv({ LANG: 'fr_FR.utf8' }, USER, opts).LANG).toBe('fr_FR.utf8');
        expect(terminalEnv({}, USER, { ...opts, locale: null }).LANG).toBe('en_US.UTF-8');
    });

    test('Windows: the base environment as is, plus the terminal variables only', () => {
        const env = terminalEnv({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ada', CLAUDECODE: '1' }, USER, { platform: 'win32', shell: 'C:\\pwsh.exe' });
        expect(env).toEqual({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ada', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'VaultAgent', TERM_PROGRAM_VERSION: expect.any(String) });
    });

    test('nothing the helper holds secret can ride along', () => {
        // The MCP run token is per-child env only; this guards the prefix we own.
        const env = terminalEnv({ VAULTAGENT_MCP_TOKEN: 'secret', PATH: '/bin' }, USER, opts);
        expect(JSON.stringify(env)).not.toContain('secret');
    });
});

describe.skipIf(process.platform === 'win32')('terminalLaunch (this machine)', () => {
    test('starts in the home directory with the override honoured and not passed on', async () => {
        const saved = process.env[TERMINAL_SHELL_OVERRIDE];
        process.env[TERMINAL_SHELL_OVERRIDE] = '/bin/sh';
        try {
            const l = await terminalLaunch();
            expect(l).toMatchObject({ file: '/bin/sh', args: [], cwd: homedir() });
            expect(l.env).not.toHaveProperty(TERMINAL_SHELL_OVERRIDE);
            expect(l.env.TERM).toBe('xterm-256color');
            expect(l.env.LANG).toMatch(/UTF-?8/i);
        } finally {
            if (saved === undefined) delete process.env[TERMINAL_SHELL_OVERRIDE];
            else process.env[TERMINAL_SHELL_OVERRIDE] = saved;
        }
    });
});

/* ───────────────────────── fonts ───────────────────────── */

describe('font parsers', () => {
    test('Ghostty: each font-family in order, size, and an empty value resets', () => {
        expect(parseGhostty(fixture('ghostty-config'))).toEqual([
            { source: 'ghostty', family: 'MesloLGS Nerd Font Mono', size: 14 },
            { source: 'ghostty', family: 'Symbols Nerd Font Mono', size: 14 },
        ]);
        expect(parseGhostty(fixture('ghostty-config-reset'))).toEqual([{ source: 'ghostty', family: 'JetBrainsMono Nerd Font' }]);
        expect(parseGhostty('')).toEqual([]);
    });

    test('iTerm2: the default profile\'s Normal Font, "PostScript size"', () => {
        expect(parseIterm2(fixture('iterm2.plist'))).toEqual([{ source: 'iterm2', postscript: 'MesloLGS-NF-Regular', size: 13 }]);
        expect(parseIterm2('not a plist')).toEqual([]);
        expect(parseIterm2('<plist><dict></dict></plist>')).toEqual([]);
    });

    test('kitty: plain and structured font_family, size; `auto` names nothing', () => {
        expect(parseKitty(fixture('kitty.conf'))).toEqual([{ source: 'kitty', family: 'FiraCode Nerd Font', size: 12.5 }]);
        expect(parseKitty(fixture('kitty-structured.conf'))).toEqual([{ source: 'kitty', family: 'Hack Nerd Font Mono', postscript: 'HackNFM-Regular', size: 13 }]);
        expect(parseKitty('font_family auto\n')).toEqual([]);
    });

    test('Alacritty: [font.normal] family, [font] size, not other styles', () => {
        expect(parseAlacritty(fixture('alacritty.toml'))).toEqual([{ source: 'alacritty', family: 'CaskaydiaCove Nerd Font', size: 13 }]);
        expect(parseAlacritty('[font]\nnormal = { family = "Inline Mono", style = "Regular" }\nsize = 9\n')).toEqual([{ source: 'alacritty', family: 'Inline Mono', size: 9 }]);
    });

    test('WezTerm: font_with_fallback, ignoring comments', () => {
        expect(parseWezterm(fixture('wezterm.lua'))).toEqual([
            { source: 'wezterm', family: 'Iosevka Nerd Font', size: 15 },
            { source: 'wezterm', family: 'Apple Color Emoji', size: 15 },
        ]);
        expect(parseWezterm('config.font = wezterm.font("Single Mono")')).toEqual([{ source: 'wezterm', family: 'Single Mono' }]);
        expect(parseWezterm('config.font = wezterm.font { family = "Table Mono" }')).toEqual([{ source: 'wezterm', family: 'Table Mono' }]);
    });

    test('Windows Terminal: the default profile, then profiles.defaults (JSON with comments)', () => {
        expect(parseWindowsTerminal(fixture('windows-terminal.json'))).toEqual([
            { source: 'windows-terminal', family: 'MesloLGM Nerd Font', size: 11 },
            { source: 'windows-terminal', family: 'Cascadia Code NF', size: 11 },
        ]);
        expect(parseWindowsTerminal('{"profiles":{"defaults":{"fontFace":"Old Style","fontSize":10}}}')).toEqual([{ source: 'windows-terminal', family: 'Old Style', size: 10 }]);
        expect(parseWindowsTerminal('{broken')).toEqual([]);
    });

    test('VS Code: the CSS list, minus generics', () => {
        expect(parseVscode(fixture('vscode-settings.json'))).toEqual([
            { source: 'vscode', family: 'MesloLGS NF', size: 13 },
            { source: 'vscode', family: 'Hack Nerd Font', size: 13 },
        ]);
        expect(parseVscode('{"editor.fontFamily":"Menlo"}')).toEqual([]);
    });

    test('Terminal.app: the default profile\'s archived font, in two steps', () => {
        const b64 = terminalAppFontData(fixture('terminal-app.plist'));
        expect(b64).toBe(readFileSync(join(import.meta.dir, 'fixtures', 'terminal-fonts', 'terminal-app-font.b64'), 'utf8').trim());
        expect(parseTerminalAppFont(fixture('terminal-app-font.xml'))).toEqual([{ source: 'terminal-app', postscript: 'SFMono-Regular', size: 12 }]);
        expect(terminalAppFontData('<plist><dict><key>Default Window Settings</key><string>Gone</string></dict></plist>')).toBeNull();
    });

    test.skipIf(process.platform !== 'darwin')('Terminal.app: plutil really decodes the stored form (macOS)', async () => {
        const archive = await realFontHintDeps.decodeArchive(terminalAppFontData(fixture('terminal-app.plist'))!);
        expect(archive).not.toBeNull();
        expect(parseTerminalAppFont(archive!)).toEqual([{ source: 'terminal-app', postscript: 'SFMono-Regular', size: 12 }]);
    });

    test('a name that could break out of CSS is dropped, a nonsense size ignored', () => {
        expect(parseGhostty('font-family = "Evil\\"; } body { x\nfont-family = Fine Mono\nfont-size = 9000')).toEqual([{ source: 'ghostty', family: 'Fine Mono' }]);
        expect(parseKitty('font_family a;b\n')).toEqual([]);
    });

    test('the plist and JSONC readers', () => {
        expect(parsePlist('<plist><dict><key>a</key><array><integer>1</integer><real>2.5</real><true/></array><key>b</key><string>x &lt; y &#65;</string></dict></plist>'))
            .toEqual({ a: [1, 2.5, true], b: 'x < y A' });
        expect(parsePlist('<plist><dict><key>a</key>')).toEqual({});
        expect(parsePlist('')).toBeNull();
        expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: 'http://x', b: [1, 2] });
        expect(parseJsonc('nope')).toBeNull();
    });
});

describe('collectFontHints', () => {
    function deps(files: Record<string, string>, commands: Record<string, string> = {}, extra: Partial<FontHintDeps> = {}): FontHintDeps {
        return {
            platform: 'darwin', home: '/Users/ada', env: {},
            readText: async p => files[p] ?? null,
            run: async cmd => commands[cmd.join(' ')] ?? null,
            decodeArchive: async () => fixture('terminal-app-font.xml'),
            ...extra,
        };
    }

    test('best first, Terminal.app last, duplicates dropped', async () => {
        const hints = await collectFontHints(deps(
            { '/Users/ada/.config/ghostty/config': 'font-family = "Fira Code"\n', '/Users/ada/Library/Application Support/Code/User/settings.json': fixture('vscode-settings.json') },
            { 'defaults export com.googlecode.iterm2 -': fixture('iterm2.plist'), 'defaults export com.apple.Terminal -': fixture('terminal-app.plist') },
        ));
        expect(hints.map(h => `${h.source}:${h.family ?? h.postscript}`)).toEqual([
            'ghostty:Fira Code', 'iterm2:MesloLGS-NF-Regular', 'vscode:MesloLGS NF', 'vscode:Hack Nerd Font', 'terminal-app:SFMono-Regular',
        ]);
    });

    test('nothing installed, a throwing reader, or a failing command: just an empty list', async () => {
        expect(await collectFontHints(deps({}))).toEqual([]);
        expect(await collectFontHints(deps({}, {}, { readText: async () => { throw new Error('boom'); }, run: async () => { throw new Error('boom'); } }))).toEqual([]);
    });

    test('Windows reads Windows Terminal and APPDATA-based VS Code', async () => {
        const local = 'C:\\Users\\ada\\AppData\\Local';
        const hints = await collectFontHints(deps(
            { [join(local, 'Microsoft', 'Windows Terminal', 'settings.json')]: fixture('windows-terminal.json') },
            {},
            { platform: 'win32', home: 'C:\\Users\\ada', env: { LOCALAPPDATA: local, APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' } },
        ));
        expect(hints.map(h => h.family)).toEqual(['MesloLGM Nerd Font', 'Cascadia Code NF']);
    });
});

/* ───────────────────────── the manager (fake PTY) ───────────────────────── */

class FakeTimers implements Timers {
    private next = 1;
    private queue: { id: number; at: number; fn: () => void }[] = [];
    now = 0;
    set(fn: () => void, ms: number): unknown {
        const id = this.next++;
        this.queue.push({ id, at: this.now + ms, fn });
        return id;
    }
    clear(handle: unknown): void {
        this.queue = this.queue.filter(t => t.id !== handle);
    }
    advance(ms: number): void {
        const to = this.now + ms;
        for (;;) {
            const due = this.queue.filter(t => t.at <= to).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            this.queue = this.queue.filter(t => t !== due);
            this.now = due.at;
            due.fn();
        }
        this.now = to;
    }
    get pending(): number {
        return this.queue.length;
    }
}

class Owner {
    readonly msgs: HelperMessage[] = [];
    send(m: HelperMessage): void {
        this.msgs.push(m);
    }
    output(termId: string): string {
        return this.msgs.flatMap(m => (m.type === 'terminal.output' && m.termId === termId ? [m.data] : [])).join('');
    }
    types(): string[] {
        return this.msgs.map(m => (m.type === 'terminal.output' && m.reset ? 'reset' : m.type));
    }
}

const launch = async () => ({ file: '/fake/zsh', args: ['-l'], env: { TERM: 'xterm-256color' }, cwd: '/home/ada' });
const newId = () => crypto.randomUUID();
const settle = () => Bun.sleep(15);

function rig(over: { maxTerminals?: number } = {}) {
    const backend = fakeBackend();
    const timers = new FakeTimers();
    const mgr = new TerminalManager({ backend, launch, timers, ...over });
    return { backend, timers, mgr, owner: new Owner() };
}

describe('TerminalManager: open', () => {
    test('spawns the launch spec at the requested size and reports shell, pid and backend', async () => {
        const { backend, mgr, owner } = rig();
        const r = await mgr.open(owner, newId(), 120, 40);
        expect(r).toEqual({ shell: '/fake/zsh', pid: backend.spawned[0].pid, backend: 'inprocess' });
        expect(backend.spawned[0].options).toMatchObject({ file: '/fake/zsh', args: ['-l'], cwd: '/home/ada', cols: 120, rows: 40 });
        expect(mgr.count()).toBe(1);
        await mgr.closeAll();
    });

    test('ids must be UUIDs, and an id is never reused', async () => {
        const { mgr, owner } = rig();
        for (const bad of ['', 'x', '../../etc', 'a'.repeat(200), 42, null, undefined, '11111111-2222-4333-8444-55555555555']) {
            await expect(mgr.open(owner, bad, 80, 24)).rejects.toBeInstanceOf(BadRequest);
        }
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        await expect(mgr.open(owner, id, 80, 24)).rejects.toBeInstanceOf(BadRequest);
        expect(mgr.count()).toBe(1);
        await mgr.closeAll();
    });

    test('sizes are clamped; a non-number is refused', async () => {
        const { backend, mgr, owner } = rig();
        await mgr.open(owner, newId(), 99999, -5);
        expect(backend.spawned[0].size).toEqual({ cols: TERMINAL_MAX_COLS, rows: 1 });
        await mgr.open(owner, newId(), 0, 99999);
        expect(backend.spawned[1].size).toEqual({ cols: 2, rows: TERMINAL_MAX_ROWS });
        await expect(mgr.open(owner, newId(), '80', 24)).rejects.toBeInstanceOf(BadRequest);
        await expect(mgr.open(owner, newId(), NaN, 24)).rejects.toBeInstanceOf(BadRequest);
        await mgr.closeAll();
    });

    test('MAX_TERMINALS per connection; another connection has its own allowance', async () => {
        const { mgr, owner } = rig();
        const ids = Array.from({ length: MAX_TERMINALS }, newId);
        for (const id of ids) await mgr.open(owner, id, 80, 24);
        await expect(mgr.open(owner, newId(), 80, 24)).rejects.toBeInstanceOf(TerminalLimit);
        await mgr.open(new Owner(), newId(), 80, 24);
        // Closing one frees a slot.
        mgr.close(owner, ids[0]);
        await mgr.open(owner, newId(), 80, 24);
        await mgr.closeAll();
    });

    test('detached shells count toward a total ceiling, so reconnect loops cannot pile them up', async () => {
        const { mgr } = rig({ maxTerminals: 2 });
        for (let i = 0; i < 3; i++) {
            const o = new Owner();
            await mgr.open(o, newId(), 80, 24);
            await mgr.open(o, newId(), 80, 24);
            mgr.detachAll(o);
        }
        await expect(mgr.open(new Owner(), newId(), 80, 24)).rejects.toBeInstanceOf(TerminalLimit);
        await mgr.closeAll();
    });

    test('a spawn that fails leaves nothing behind and the id is free again', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        backend.failNext = new Error('no such shell');
        await expect(mgr.open(owner, id, 80, 24)).rejects.toThrow('no such shell');
        expect(mgr.count()).toBe(0);
        await mgr.open(owner, id, 80, 24);
        await mgr.closeAll();
    });
});

describe('TerminalManager: input, resize, close', () => {
    test('input reaches the shell; over the cap, from a stranger, or after exit it is dropped', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        mgr.input(owner, id, 'ls\r');
        mgr.input(owner, id, 'x'.repeat(TERMINAL_INPUT_MAX_CHARS));
        mgr.input(owner, id, 'x'.repeat(TERMINAL_INPUT_MAX_CHARS + 1));
        mgr.input(owner, id, 42);
        mgr.input(new Owner(), id, 'stranger');
        mgr.input(owner, newId(), 'nobody');
        expect(pty.written.map(w => w.length)).toEqual([3, TERMINAL_INPUT_MAX_CHARS]);
        pty.end({ code: 0, signal: null });
        mgr.input(owner, id, 'late');
        expect(pty.written.length).toBe(2);
        await mgr.closeAll();
    });

    test('resize clamps, and resizes both the shell and the mirror', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        mgr.resize(owner, id, 100, 30);
        expect(backend.spawned[0].size).toEqual({ cols: 100, rows: 30 });
        mgr.resize(owner, id, 5000, 5000);
        expect(backend.spawned[0].size).toEqual({ cols: TERMINAL_MAX_COLS, rows: TERMINAL_MAX_ROWS });
        expect(() => mgr.resize(owner, id, 'a', 24)).toThrow(BadRequest);
        expect(() => mgr.resize(owner, newId(), 80, 24)).toThrow(TerminalNotFound);
        expect(() => mgr.resize(new Owner(), id, 80, 24)).toThrow(TerminalNotFound);
        await mgr.closeAll();
    });

    test('close kills the shell once and forgets it; closing again is fine; a stranger may not', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        expect(() => mgr.close(new Owner(), id)).toThrow(TerminalNotFound);
        mgr.close(owner, id);
        mgr.close(owner, id);
        expect(backend.spawned[0].kills).toBe(1);
        expect(mgr.count()).toBe(0);
    });
});

describe('TerminalManager: output', () => {
    test('output is coalesced for a few ms into one frame', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        pty.emit('a');
        pty.emit('b');
        pty.emit('c');
        expect(owner.msgs).toEqual([]);
        timers.advance(5);
        expect(owner.msgs).toEqual([{ type: 'terminal.output', termId: id, data: 'abc' }]);
        await mgr.closeAll();
    });

    test('a frame is sent at once when 64 KiB has gathered', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        backend.spawned[0].emit('x'.repeat(70_000));
        expect(owner.output(id).length).toBe(70_000);
        await mgr.closeAll();
    });

    test('UTF-8 split across two reads is decoded whole', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const bytes = new TextEncoder().encode('é€😀');
        for (const b of bytes) backend.spawned[0].emit(new Uint8Array([b])); // the worst split: byte by byte
        timers.advance(5);
        expect(owner.output(id)).toBe('é€😀');
        await mgr.closeAll();
    });

    test('flow control: over HIGH it stops streaming, and under LOW one reset snapshot resynchronizes', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        const chunk = 'a'.repeat(70_000);
        let sent = 0;
        while (sent <= TERMINAL_ACK_HIGH) {
            pty.emit(chunk);
            sent += chunk.length;
        }
        const frames = owner.msgs.length;
        // Behind: more output reaches the mirror only.
        pty.emit('\r\nTAIL-MARKER-1\r\n');
        timers.advance(50);
        expect(owner.msgs.length).toBe(frames);

        // The panel acknowledges everything: one snapshot, flagged reset, that includes what it missed.
        mgr.ack(owner, id, sent);
        await settle();
        const last = owner.msgs.at(-1)!;
        expect(last).toMatchObject({ type: 'terminal.output', termId: id, reset: true });
        expect((last as { data: string }).data).toContain('TAIL-MARKER-1');
        expect(owner.msgs.length).toBe(frames + 1);

        // Streaming resumed, after the snapshot.
        pty.emit('after');
        timers.advance(5);
        expect(owner.msgs.at(-1)).toEqual({ type: 'terminal.output', termId: id, data: 'after' });
        await mgr.closeAll();
    });

    test('an ack that leaves it above LOW changes nothing; bogus acks are ignored', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        for (let i = 0; i < 8; i++) pty.emit('a'.repeat(70_000)); // 560k: behind
        const frames = owner.msgs.length;
        mgr.ack(owner, id, 100_000); // 460k left: still behind
        mgr.ack(owner, id, -5);
        mgr.ack(owner, id, NaN);
        mgr.ack(owner, id, 'lots');
        mgr.ack(new Owner(), id, 10_000_000);
        await settle();
        timers.advance(50);
        expect(owner.msgs.length).toBe(frames);
        await mgr.closeAll();
    });

    test('Ctrl-C is never queued behind output', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        for (let i = 0; i < 20; i++) backend.spawned[0].emit('a'.repeat(70_000));
        mgr.input(owner, id, '\x03');
        expect(backend.spawned[0].written).toEqual(['\x03']);
        await mgr.closeAll();
    });
});

describe('TerminalManager: dropped frames', () => {
    /** An owner whose socket is past its backpressure limit until `full` goes false. */
    class FullOwner extends Owner {
        full = true;
        override send(m: HelperMessage): boolean {
            if (this.full) return false;
            super.send(m);
            return true;
        }
    }

    test('a dropped output frame stops streaming, then one reset snapshot resyncs once a send gets through', async () => {
        const backend = fakeBackend();
        const timers = new FakeTimers();
        const mgr = new TerminalManager({ backend, launch, timers });
        const owner = new FullOwner();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        pty.emit('LOST');
        timers.advance(5);                 // the flush: dropped
        pty.emit('-while-behind');
        timers.advance(300);               // the retry: its snapshot is dropped too
        await settle();
        expect(owner.msgs).toEqual([]);
        owner.full = false;
        timers.advance(300);               // the next retry gets through
        await settle();
        expect(owner.types()).toEqual(['reset']);
        expect(owner.output(id)).toContain('LOST-while-behind');
        pty.emit('live');
        timers.advance(5);
        expect(owner.types()).toEqual(['reset', 'terminal.output']);
        await mgr.closeAll();
    });
});

describe('TerminalManager: exit', () => {
    test('the end follows the last output, and the session stays until closed', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        backend.spawned[0].emit('bye\r\n');
        backend.spawned[0].end({ code: 2, signal: null });
        expect(owner.types()).toEqual(['terminal.output', 'terminal.exit']);
        expect(owner.msgs.at(-1)).toEqual({ type: 'terminal.exit', termId: id, code: 2, signal: null });
        expect(mgr.count()).toBe(1);
        // The backend's handle is released, and a later close is harmless.
        expect(backend.spawned[0].kills).toBe(1);
        mgr.close(owner, id);
        expect(mgr.count()).toBe(0);
    });

    test('a signal ends it with code null', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        backend.spawned[0].end({ code: null, signal: 'SIGKILL' });
        expect(owner.msgs.at(-1)).toEqual({ type: 'terminal.exit', termId: id, code: null, signal: 'SIGKILL' });
        await mgr.closeAll();
    });

    test('when it ends while behind, the end waits for the catch-up snapshot', async () => {
        const { backend, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        for (let i = 0; i < 8; i++) backend.spawned[0].emit('a'.repeat(70_000));
        backend.spawned[0].emit('LAST-WORDS');
        backend.spawned[0].end({ code: 0, signal: null });
        expect(owner.msgs.some(m => m.type === 'terminal.exit')).toBe(false);
        mgr.ack(owner, id, 8 * 70_000);
        await settle();
        expect(owner.types().slice(-2)).toEqual(['reset', 'terminal.exit']);
        await mgr.closeAll();
    });

    test('when it ends while detached, attach reports it and does not announce it again', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        mgr.detachAll(owner);
        backend.spawned[0].end({ code: 5, signal: null });
        const back = new Owner();
        const r = await mgr.attach(back, id, 80, 24);
        expect(r.exited).toEqual({ code: 5, signal: null });
        timers.advance(50);
        expect(back.msgs).toEqual([]);
        await mgr.closeAll();
    });
});

describe('TerminalManager: detach, attach, steal', () => {
    test('a detached shell runs on, then is killed after the TTL', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        mgr.detachAll(owner);
        timers.advance(TERMINAL_DETACHED_TTL_MS - 1);
        expect(backend.spawned[0].kills).toBe(0);
        expect(mgr.count()).toBe(1);
        timers.advance(1);
        expect(backend.spawned[0].kills).toBe(1);
        expect(mgr.count()).toBe(0);
        // Nothing left scheduled (no leaked flush or TTL timers).
        expect(timers.pending).toBe(0);
    });

    test('attach cancels the TTL and returns the screen, scrollback and what ran while detached', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 4);
        const pty = backend.spawned[0];
        pty.emit('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6');
        mgr.detachAll(owner);
        pty.emit('\r\nwhile-away');
        timers.advance(TERMINAL_DETACHED_TTL_MS - 1);
        const back = new Owner();
        const r = await mgr.attach(back, id, 100, 10);
        expect(r.shell).toBe('/fake/zsh');
        expect(r.exited).toBeNull();
        for (const line of ['line1', 'line3', 'line6', 'while-away']) expect(r.snapshot).toContain(line);
        expect(pty.size).toEqual({ cols: 100, rows: 10 });
        timers.advance(TERMINAL_DETACHED_TTL_MS * 2);
        expect(pty.kills).toBe(0);
        await mgr.closeAll();
    });

    test('output that arrives while the snapshot is taken follows it, once', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const pty = backend.spawned[0];
        pty.emit('before');
        mgr.detachAll(owner);
        const back = new Owner();
        const attached = mgr.attach(back, id, 80, 24);
        pty.emit('-during'); // after the attach started, before its snapshot is taken
        const r = await attached;
        expect(r.snapshot).toContain('before');
        expect(back.msgs).toEqual([]); // nothing may precede the response
        timers.advance(5);
        // Exactly once: not in the snapshot AND after it (the parser's time slicing once did that).
        expect(r.snapshot).not.toContain('-during');
        expect(back.output(id)).toBe('-during');
        await mgr.closeAll();
    });

    test('attach from another connection steals: the old owner is told, and loses its input and acks', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        const thief = new Owner();
        await mgr.attach(thief, id, 80, 24);
        expect(owner.msgs).toEqual([{ type: 'terminal.detached', termId: id }]);
        mgr.input(owner, id, 'old');
        mgr.input(thief, id, 'new');
        expect(backend.spawned[0].written).toEqual(['new']);
        backend.spawned[0].emit('x');
        timers.advance(5);
        expect(thief.output(id)).toBe('x');
        expect(owner.output(id)).toBe('');
        // The old connection closing now must not detach the new owner's session.
        mgr.detachAll(owner);
        backend.spawned[0].emit('y');
        timers.advance(5);
        expect(thief.output(id)).toBe('xy');
        await mgr.closeAll();
    });

    test('re-attaching on the same connection is not a steal', async () => {
        const { mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        await mgr.attach(owner, id, 80, 24);
        expect(owner.msgs).toEqual([]);
        await mgr.closeAll();
    });

    test('attach to nothing, or with a bad id, is refused', async () => {
        const { mgr, owner } = rig();
        await expect(mgr.attach(owner, newId(), 80, 24)).rejects.toBeInstanceOf(TerminalNotFound);
        await expect(mgr.attach(owner, 'nope', 80, 24)).rejects.toBeInstanceOf(BadRequest);
    });

    test('a connection that closes while its attach awaits the snapshot leaves the shell detached, with its TTL', async () => {
        const { backend, timers, mgr, owner } = rig();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        mgr.detachAll(owner);
        const back = new Owner();
        const attaching = mgr.attach(back, id, 80, 24);
        mgr.detachAll(back);   // its socket closed before the snapshot resolved
        await expect(attaching).rejects.toBeInstanceOf(TerminalNotFound);
        timers.advance(TERMINAL_DETACHED_TTL_MS);
        expect(backend.spawned[0].kills).toBe(1);
        expect(mgr.count()).toBe(0);
    });

    test('a connection that closes while its shell is still spawning detaches it too', async () => {
        const backend = fakeBackend();
        const timers = new FakeTimers();
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        const mgr = new TerminalManager({ backend, timers, launch: async () => { await gate; return launch(); } });
        const owner = new Owner();
        const opening = mgr.open(owner, newId(), 80, 24);
        mgr.detachAll(owner);
        release();
        await opening;
        timers.advance(TERMINAL_DETACHED_TTL_MS);
        expect(backend.spawned[0].kills).toBe(1);
        expect(mgr.count()).toBe(0);
    });
});

describe('TerminalManager: closeAll', () => {
    test('hangs up every shell, attached or not, and empties', async () => {
        const { backend, mgr, owner } = rig();
        await mgr.open(owner, newId(), 80, 24);
        const second = newId();
        await mgr.open(owner, second, 80, 24);
        await mgr.open(owner, newId(), 80, 24);
        mgr.detachAll(owner);
        await mgr.closeAll();
        expect(backend.spawned.map(p => p.kills)).toEqual([1, 1, 1]);
        expect(mgr.count()).toBe(0);
    });

    test('a shell that never reports its end does not hold shutdown past the limit', async () => {
        const backend = fakeBackend();
        const timers = new FakeTimers();
        const mgr = new TerminalManager({ backend, launch, timers });
        await mgr.open(new Owner(), newId(), 80, 24);
        backend.spawned[0].kill = () => { /* stubborn: no exit */ };
        const done = mgr.closeAll();
        await settle();
        timers.advance(3000);
        await done;
        expect(mgr.count()).toBe(0);
    });
});

/* ───────────────────────── backend choice ───────────────────────── */

describe('chooseBackend', () => {
    const layout = { appDir: '/Users/ada/Library/Application Support/VaultAgent', ptyHostSocket: '/sock/pty.sock' } as unknown as InstallLayout;
    function parts(probeResult: () => boolean) {
        const inproc = fakeBackend('inprocess');
        const host = fakeBackend('ptyhost');
        const probed: string[] = [];
        const deps: BackendDeps = {
            inProcess: () => inproc,
            host: s => {
                probed.push(`host:${s}`);
                return host;
            },
            probe: async s => {
                probed.push(`probe:${s}`);
                return probeResult();
            },
        };
        return { inproc, host, probed, deps };
    }
    const opts = { file: '/bin/sh', args: [], env: {}, cwd: '/', cols: 80, rows: 24 };
    const cbs = { onData() {}, onExit() {} };

    test('anything but an installed macOS helper is in-process, without probing', () => {
        for (const [platform, installed] of [['macos', false], ['linux', true], ['windows', true]] as const) {
            const p = parts(() => true);
            expect(chooseBackend(platform, layout, installed, p.deps)).toBe(p.inproc);
            expect(p.probed).toEqual([]);
        }
    });

    test('installed macOS: the PTY host when it answers', async () => {
        const p = parts(() => true);
        const b = chooseBackend('macos', layout, true, p.deps);
        expect(b.kind).toBe('ptyhost');
        await b.spawn(opts, cbs);
        expect(p.host.spawned.length).toBe(1);
        expect(p.probed).toContain('probe:/sock/pty.sock');
        expect(b.kind).toBe('ptyhost');
    });

    test('installed macOS: falls back to in-process while the host is down (logged once), and returns to it when it is back', async () => {
        let up = false;
        const p = parts(() => up);
        const log = join(mkdtempSync(join(tmpdir(), 'bme-log-')), 'helper.log');
        setLogFile(log);
        const b = chooseBackend('macos', layout, true, p.deps);
        try {
            await b.spawn(opts, cbs);
            await b.spawn(opts, cbs);
        } finally {
            setLogFile(null);
        }
        expect(readFileSync(log, 'utf8').match(/PTY host is not answering/g)?.length).toBe(1);
        expect(p.inproc.spawned.length).toBe(2);
        expect(b.kind).toBe('inprocess');
        up = true;
        await b.spawn(opts, cbs);
        expect(p.host.spawned.length).toBe(1);
        expect(b.kind).toBe('ptyhost');
    });

    test('the socket defaults to pty.sock in the app dir', async () => {
        const p = parts(() => true);
        const b = chooseBackend('macos', { appDir: '/app' } as unknown as InstallLayout, true, p.deps);
        await b.spawn(opts, cbs);
        expect(p.probed).toContain('probe:/app/pty.sock');
    });
});

/* ───────────────────────── privacy ───────────────────────── */

describe('privacy probe', () => {
    test('exit 0 granted, 1 not, anything else unknown', () => {
        expect(interpretProbeExit(0)).toBe(true);
        expect(interpretProbeExit(1)).toBe(false);
        expect(interpretProbeExit(2)).toBeNull();
        expect(interpretProbeExit(null)).toBeNull();
    });

    test('runs a short /bin/sh test THROUGH the backend, and only the PTY host\'s answer counts', async () => {
        for (const [kind, code, expected] of [['ptyhost', 0, true], ['ptyhost', 1, false], ['ptyhost', 127, null], ['inprocess', 0, null]] as const) {
            const backend = fakeBackend(kind);
            const done = fullDiskAccess(backend, '/Users/ada');
            await settle();
            const pty = backend.spawned[0];
            expect(pty.options.file).toBe('/bin/sh');
            expect(pty.options.args.join(' ')).toContain('com.apple.TCC/TCC.db');
            expect(pty.options.cwd).toBe('/Users/ada');
            pty.end({ code, signal: null });
            expect(await done).toBe(expected);
        }
    });

    test('a spawn failure is "unknown", not an error', async () => {
        const backend = fakeBackend('ptyhost');
        backend.failNext = new Error('host down');
        expect(await fullDiskAccess(backend)).toBeNull();
    });
});

/* ───────────────────────── a real PTY ───────────────────────── */

describe.skipIf(process.platform === 'win32')('real PTY (/bin/sh)', () => {
    async function until(owner: Owner, id: string, pred: (out: string) => boolean, ms = 8000): Promise<void> {
        const stop = Date.now() + ms;
        while (Date.now() < stop) {
            if (pred(owner.output(id))) return;
            await Bun.sleep(20);
        }
        throw new Error(`timed out; output so far: ${JSON.stringify(owner.output(id))}`);
    }
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    test('echo, resize is seen by the shell, close hangs up a background child', async () => {
        const backend: PtyBackend = inProcessBackend();
        const mgr = new TerminalManager({
            backend,
            launch: async () => ({ file: '/bin/sh', args: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ' }, cwd: tmpdir() }),
        });
        const owner = new Owner();
        const id = newId();
        const opened = await mgr.open(owner, id, 100, 30);
        expect(opened).toMatchObject({ shell: '/bin/sh', backend: 'inprocess' });

        const marker = `m${Date.now()}`;
        mgr.input(owner, id, `echo ${marker}$((20+22))\r`);
        await until(owner, id, o => o.includes(`${marker}42`));

        mgr.input(owner, id, 'stty size\r');
        await until(owner, id, o => o.includes('30 100'));
        mgr.resize(owner, id, 50, 20);
        mgr.input(owner, id, 'stty size\r');
        await until(owner, id, o => /\r\n20 50\r\n/.test(o));

        mgr.input(owner, id, 'sleep 300 & echo bgpid=$!\r');
        await until(owner, id, o => /bgpid=\d+\r\n/.test(o));
        const bg = Number(/bgpid=(\d+)\r\n/.exec(owner.output(id))![1]);
        expect(alive(bg)).toBe(true);
        mgr.close(owner, id);
        const stop = Date.now() + 5000;
        while (alive(bg) && Date.now() < stop) await Bun.sleep(50);
        expect(alive(bg)).toBe(false);
        expect(mgr.count()).toBe(0);
    });

    test('a shell that exits reports its code, and attach returns the screen', async () => {
        const mgr = new TerminalManager({
            backend: inProcessBackend(),
            launch: async () => ({ file: '/bin/sh', args: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ' }, cwd: tmpdir() }),
        });
        const owner = new Owner();
        const id = newId();
        await mgr.open(owner, id, 80, 24);
        mgr.input(owner, id, 'echo screen-text; exit 9\r');
        const stop = Date.now() + 8000;
        while (!owner.msgs.some(m => m.type === 'terminal.exit') && Date.now() < stop) await Bun.sleep(20);
        expect(owner.msgs.find(m => m.type === 'terminal.exit')).toMatchObject({ code: 9, signal: null });
        const r = await mgr.attach(new Owner(), id, 80, 24);
        expect(r.exited).toEqual({ code: 9, signal: null });
        expect(r.snapshot).toContain('screen-text');
        await mgr.closeAll();
    });
});
