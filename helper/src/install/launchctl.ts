// launchctl, for the two LaunchAgents (the helper and the PTY host). Injectable:
// tests hand in a stub, because nothing in a test may ever load a job into the
// real user's launchd domain.

import { runCapture } from '../proc.ts';

export type Launchctl = (...args: string[]) => Promise<{ code: number | null }>;

export const launchctl: Launchctl = (...args) => runCapture(['/bin/launchctl', ...args], { timeoutMs: 15_000 });

function uid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : 0;
}

/** The user's GUI domain: where a LaunchAgent has to be bootstrapped to see their session. */
export const guiDomain = (): string => `gui/${uid()}`;

export async function isLoaded(label: string, run: Launchctl = launchctl): Promise<boolean> {
    return (await run('print', `${guiDomain()}/${label}`)).code === 0;
}

/** Unload a login item and wait (≤5 s) until launchd no longer knows it. */
export async function bootoutAndWait(label: string, run: Launchctl = launchctl): Promise<void> {
    const target = `${guiDomain()}/${label}`;
    await run('bootout', target);
    for (let i = 0; i < 25; i++) {
        if ((await run('print', target)).code !== 0) return;
        await Bun.sleep(200);
    }
}

/**
 * Bootstrap a plist into the GUI domain. A bootstrap right behind a bootout can
 * still fail with "5: Input/output error" while launchd finishes tearing the old
 * job down, so it is retried. Returns the last exit code.
 */
export async function bootstrapWithRetry(plist: string, run: Launchctl = launchctl, retryMs = 1000): Promise<number | null> {
    let r = await run('bootstrap', guiDomain(), plist);
    for (let i = 0; r.code !== 0 && i < 4; i++) {
        await Bun.sleep(retryMs);
        r = await run('bootstrap', guiDomain(), plist);
    }
    return r.code;
}
