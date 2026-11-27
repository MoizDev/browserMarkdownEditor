import { installCounterRuntime } from './counterRuntime.mjs';

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

export async function readCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.read();
    });
}
export async function resetCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.reset();
    });
}
