// macOS privacy (TCC) helpers for the terminal panel's one-time Full Disk Access
// notice. Everything here is about the PTY host: its grants are the ones that
// survive VaultAgent updates, so it is the host's identity that must be probed.

import { homedir } from 'node:os';
import type { TerminalBackend } from '../../../shared/vaultAgentProtocol.ts';
import { runCapture } from '../proc.ts';
import type { PtyBackend } from './types.ts';

const PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const PROBE_TIMEOUT_MS = 5000;

/** Exit 0 → readable (granted), 1 → not readable, anything else → could not tell. */
export function interpretProbeExit(code: number | null): boolean | null {
    return code === 0 ? true : code === 1 ? false : null;
}

/**
 * Whether Full Disk Access is granted to whatever owns the backend's shells:
 * a short `test -r …/TCC.db` run THROUGH the backend, so it is the PTY host's
 * identity that is tested and not the main helper's. null = not macOS, not the
 * PTY host (the in-process helper's grants do not persist, so no notice), or the
 * probe failed. The TCC.db path may move in a future macOS: null then, no notice.
 */
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
    // It was the PTY host's identity only if the host actually ran it.
    const kind: TerminalBackend = backend.kind;
    const timer = setTimeout(() => pty.kill(), PROBE_TIMEOUT_MS);
    // A kill that never reports an exit must not hang the panel's request.
    await Promise.race([finished, Bun.sleep(PROBE_TIMEOUT_MS + 2500)]);
    clearTimeout(timer);
    return kind === 'ptyhost' ? interpretProbeExit(code) : null;
}

export async function terminalPrivacy(backend: PtyBackend, platform: NodeJS.Platform = process.platform): Promise<{ backend: TerminalBackend; fullDiskAccess: boolean | null }> {
    if (platform !== 'darwin') return { backend: backend.kind, fullDiskAccess: null };
    const fda = await fullDiskAccess(backend);
    // Read after the probe: the backend may have fallen back while spawning it.
    return { backend: backend.kind, fullDiskAccess: fda };
}

/** System Settings → Privacy & Security → Full Disk Access. */
export async function openPrivacySettings(): Promise<void> {
    await runCapture(['open', PRIVACY_URL], { timeoutMs: 5000 });
}

/** Finder, with the PTY host selected, ready to drag into the Full Disk Access list. */
export async function revealPtyHost(path: string): Promise<void> {
    await runCapture(['open', '-R', path], { timeoutMs: 5000 });
}
