// install/uninstall with `root`: the exact files per OS, laid out in a scratch
// folder. `root` also means nothing is registered with the OS (no launchctl,
// schtasks or systemctl) — these tests must never touch the real machine.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { HelperPlatform } from '../../shared/vaultAgentProtocol.ts';
import { install, uninstall } from '../src/install/index.ts';
import { LAUNCHD_LABEL, autostartDesktop, installLayout, launchdPlist, systemdUnit, windowsTaskXml } from '../src/install/layout.ts';

const PROBE = join(import.meta.dir, '..', 'dist', '.probe');
let root: string;
let source: string;

beforeEach(() => {
    mkdirSync(PROBE, { recursive: true });
    root = mkdtempSync(join(PROBE, 'install-'));
    source = join(root, 'source-binary');
    writeFileSync(source, '#!/bin/sh\necho fake\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function listAll(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter(e => e.isFile())
        .map(e => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
        .sort();
}

const home = () => join(root, 'home');

describe('layout per OS', () => {
    test('macOS', async () => {
        const l = await install({ platform: 'macos', root: home(), sourceBinary: source });
        expect(listAll(home())).toEqual([
            'Library/Application Support/VaultAgent/vaultagent',
            `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
        ]);
        expect(existsSync(join(home(), 'Library', 'Logs'))).toBe(true);
        expect(readFileSync(l.binary, 'utf8')).toBe(readFileSync(source, 'utf8'));
        if (process.platform !== 'win32') expect(statSync(l.binary).mode & 0o777).toBe(0o755);
        const plist = readFileSync(l.registrationFile!, 'utf8');
        expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
        expect(plist).toContain(`<string>${l.binary}</string>\n\t\t<string>serve</string>`);
        expect(plist).toContain(`<string>${join(home(), 'Library', 'Logs', 'VaultAgent.log')}</string>`);
        if (existsSync('/usr/bin/plutil')) {
            const r = Bun.spawnSync(['/usr/bin/plutil', '-lint', l.registrationFile!]);
            expect(r.exitCode).toBe(0);
        }
    });

    test('Linux: systemd unit + (no systemd here) XDG autostart', async () => {
        const l = await install({ platform: 'linux', root: home(), sourceBinary: source });
        expect(listAll(home())).toEqual([
            '.config/autostart/vaultagent.desktop',
            '.config/systemd/user/vaultagent.service',
            '.local/share/vaultagent/vaultagent',
        ]);
        expect(existsSync(join(home(), '.local', 'state', 'vaultagent'))).toBe(true);
        expect(readFileSync(l.registrationFile!, 'utf8')).toContain(`ExecStart="${l.binary}" serve`);
        expect(readFileSync(l.autostartFile!, 'utf8')).toContain(`Exec="${l.binary}" serve`);
    });

    test('Windows: binary only (the task is registered, not written)', async () => {
        const l = await install({ platform: 'windows', root: home(), sourceBinary: source });
        expect(listAll(home())).toEqual(['AppData/Local/VaultAgent/vaultagent.exe']);
        expect(l.logFile).toBe(join(home(), 'AppData', 'Local', 'VaultAgent', 'vaultagent.log'));
    });

    test('root ignores XDG / LOCALAPPDATA from the environment', () => {
        const env = { XDG_CONFIG_HOME: '/elsewhere', XDG_DATA_HOME: '/elsewhere', LOCALAPPDATA: 'C:/elsewhere' };
        expect(installLayout('linux', '/r', env).appDir).toBe(join('/r', '.local', 'share', 'vaultagent'));
        expect(installLayout('windows', '/r', env).appDir).toBe(join('/r', 'AppData', 'Local', 'VaultAgent'));
        // Without root they are honoured.
        expect(installLayout('linux', undefined, env).registrationFile).toBe(join('/elsewhere', 'systemd', 'user', 'vaultagent.service'));
    });
});

describe('reinstall and uninstall', () => {
    for (const platform of ['macos', 'linux', 'windows'] as HelperPlatform[]) {
        test(`${platform}: reinstall replaces in place; uninstall leaves nothing but empty folders, and keeps the sessions`, async () => {
            await install({ platform, root: home(), sourceBinary: source });
            writeFileSync(source, 'v2');
            const l = await install({ platform, root: home(), sourceBinary: source });
            expect(readFileSync(l.binary, 'utf8')).toBe('v2');
            writeFileSync(l.logFile, 'error\n');
            const sessions = join(home(), '.bme-agent-sessions', 'x');
            mkdirSync(sessions, { recursive: true });
            writeFileSync(join(sessions, 'CLAUDE.md'), 'keep');

            await uninstall({ platform, root: home() });
            expect(listAll(home())).toEqual(['.bme-agent-sessions/x/CLAUDE.md']);
            expect(existsSync(l.appDir)).toBe(false);
        });
    }

    test('uninstall of a missing install is a no-op', async () => {
        await uninstall({ platform: 'linux', root: home() });
        await uninstall({ platform: 'macos', root: home() });
        expect(listAll(home())).toEqual([]);
    });
});

describe('generated files escape their paths', () => {
    const weird = join('/Users', 'a "b" & <c> $d `e`', 'x');

    test('plist is XML-escaped', () => {
        const plist = launchdPlist(installLayout('macos', weird));
        expect(plist).toContain('a &quot;b&quot; &amp; &lt;c&gt; $d `e`');
        expect(plist).not.toContain('<c>');
    });

    test('systemd unit and desktop entry quote the binary', () => {
        const l = installLayout('linux', weird);
        expect(systemdUnit(l)).toContain('ExecStart="/Users/a \\"b\\" & <c> $d `e`/x/.local/share/vaultagent/vaultagent" serve');
        expect(autostartDesktop(l)).toContain('Exec="/Users/a \\"b\\" & <c> \\$d \\`e\\`/x/.local/share/vaultagent/vaultagent" serve');
    });

    test('task XML scopes both the trigger and the principal to the user (non-admin registration)', () => {
        const x = windowsTaskXml(installLayout('windows', 'C:/Users/Ann'), 'PC\\Ann & Co');
        expect(x.match(/<UserId>PC\\Ann &amp; Co<\/UserId>/g)?.length).toBe(2);
        expect(x).toContain('<RunLevel>LeastPrivilege</RunLevel>');
        expect(x).toContain('<Arguments>serve</Arguments>');
    });
});
