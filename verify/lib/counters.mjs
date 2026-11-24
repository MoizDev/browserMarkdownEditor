import { installCounterRuntime } from './counterRuntime.mjs';

/** Window-only entry; workers use the SAME runtime through targets.mjs.
 * Guard before touching APIs: context init scripts also enter opaque frames.
 * @param {import('playwright').BrowserContext} context
 * @param {{vaultName?: string | null, postMessages?: boolean, blobReads?: boolean}} options
 */
export async function installCounters(context, { vaultName = null, postMessages = false, blobReads = false } = {}) {
    const options = JSON.stringify({ vaultName, realm: 'window', postMessages, blobReads });
    await context.addInitScript({ content: `(() => {
        if (window !== window.top) return;
        let storage;
        try { storage = navigator.storage; } catch { return; }
        if (typeof FileSystemHandle !== 'function' || typeof FileSystemDirectoryHandle !== 'function' ||
            typeof FileSystemFileHandle !== 'function' || typeof storage?.getDirectory !== 'function') return;
        if (window.__bmeCounters) return;
        (${installCounterRuntime.toString()})(${options});
    })();` });
}

/** One browser round trip, with paths and outcome for every observed operation.
 * @param {import('playwright').Page} page
 */
export async function readCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.read();
    });
}
/** @param {import('playwright').Page} page */
export async function resetCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.reset();
    });
}
