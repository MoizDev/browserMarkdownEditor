import { runCapture } from '../proc.ts';

export type Launchctl = (...args: string[]) => Promise<{ code: number | null }>;

export const launchctl: Launchctl = (...args) => runCapture(['/bin/launchctl', ...args], { timeoutMs: 15_000 });

function uid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : 0;
}

export const guiDomain = (): string => `gui/${uid()}`;

export async function isLoaded(label: string, run: Launchctl = launchctl): Promise<boolean> {
    return (await run('print', `${guiDomain()}/${label}`)).code === 0;
}

export async function bootoutAndWait(label: string, run: Launchctl = launchctl): Promise<void> {
    const target = `${guiDomain()}/${label}`;
    await run('bootout', target);
    for (let i = 0; i < 25; i++) {
        if ((await run('print', target)).code !== 0) return;
        await Bun.sleep(200);
    }
}

export async function bootstrapWithRetry(plist: string, run: Launchctl = launchctl, retryMs = 1000): Promise<number | null> {
    let r = await run('bootstrap', guiDomain(), plist);
    for (let i = 0; r.code !== 0 && i < 4; i++) {
        await Bun.sleep(retryMs);
        r = await run('bootstrap', guiDomain(), plist);
    }
    return r.code;
}
