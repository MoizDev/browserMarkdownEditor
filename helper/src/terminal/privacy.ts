import { homedir } from 'node:os';
import type { TerminalBackend } from '../../../shared/vaultAgentProtocol.ts';
import { runCapture } from '../proc.ts';
import type { PtyBackend } from './types.ts';

const PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const PROBE_TIMEOUT_MS = 5000;

export function interpretProbeExit(code: number | null): boolean | null {
    return code === 0 ? true : code === 1 ? false : null;
}

export async function fullDiskAccess(backend: PtyBackend, home: string = homedir()): Promise<boolean | null> {
    let code: number | null = null;
    let done!: () => void;
    const finished = new Promise<void>(r => (done = r));
    let pty: Awaited<ReturnType<PtyBackend['spawn']>>;
    try {
        pty = await backend.spawn({
            file: '/bin/sh',
            args: ['-c', 'test -r "$HOME/Library/Application Support/com.apple.TCC/TCC.db"'],
            env: { HOME: home, PATH: '/usr/bin:/bin' },
            cwd: home,
            cols: 80,
            rows: 24,
        }, {
            onData: () => {},
            onExit: exit => {
                code = exit.signal ? null : exit.code;
                done();
            },
        });
    } catch {
        return null;
    }
    const kind: TerminalBackend = backend.kind;
    const timer = setTimeout(() => pty.kill(), PROBE_TIMEOUT_MS);
    await Promise.race([finished, Bun.sleep(PROBE_TIMEOUT_MS + 2500)]);
    clearTimeout(timer);
    return kind === 'ptyhost' ? interpretProbeExit(code) : null;
}

export async function terminalPrivacy(backend: PtyBackend, platform: NodeJS.Platform = process.platform): Promise<{ backend: TerminalBackend; fullDiskAccess: boolean | null }> {
    if (platform !== 'darwin') return { backend: backend.kind, fullDiskAccess: null };
    const fda = await fullDiskAccess(backend);
    return { backend: backend.kind, fullDiskAccess: fda };
}

export async function openPrivacySettings(): Promise<void> {
    await runCapture(['open', PRIVACY_URL], { timeoutMs: 5000 });
}

export async function revealPtyHost(path: string): Promise<void> {
    await runCapture(['open', '-R', path], { timeoutMs: 5000 });
}
