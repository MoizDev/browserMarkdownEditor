import { createPdfWorkerBroker } from '../contained/broker';
import { createPdfPool } from '../pool/pool';
import { installTiledPdfPool } from './installPool';
import type { PdfFocusLease } from './startup.types';
import type { RenderToken } from '../../platform/render/types';
import { pdfDocKey } from '../worker/protocol';
import type { PdfDocKey } from '../worker/protocol';
import type { PdfPool } from '../pool/types';

const focused = new Map<string, Set<object>>();
let active: { pool: PdfPool; retry(docKey: PdfDocKey): Promise<void>; dispose(): void } | undefined;

/** Lazy PDF-only callers borrow the one App-wide contained pool. */
export function getSharedPdfPool(): PdfPool {
    startPdfPool();
    if (!active) throw new Error('The contained PDF pool is unavailable');
    return active.pool;
}

export async function retryPdfPool(token: RenderToken): Promise<void> {
    await active?.retry(pdfDocKey({ ...token, source: 'outer' }));
}

/** A stale pane cleanup cannot remove another pane's focus lease (C5.3). */
export function retainPdfFocus(documentId: string): PdfFocusLease {
    const owner = {};
    let disposed = false;
    const clear = () => {
        const set = focused.get(documentId);
        set?.delete(owner);
        if (set && !set.size) focused.delete(documentId);
    };
    return {
        setFocused(value) {
            if (disposed) return;
            if (!value) { clear(); return; }
            let set = focused.get(documentId);
            if (!set) focused.set(documentId, set = new Set());
            set.add(owner);
        },
        dispose() { if (!disposed) { disposed = true; clear(); } },
    };
}

/** Install only a contained pool; failed startup/recovery never silently selects Classic (security §1). */
export function startPdfPool(): void {
    if (active) return;
    // Broker loss fails direct requests and performs bounded frame recovery. It
    // must not replace the pool underneath retained App-owned source sessions.
    const broker = createPdfWorkerBroker(() => {});
    const pool = createPdfPool({ broker });
    let uninstall: (() => void) | undefined;
    try { uninstall = installTiledPdfPool(pool, id => !!focused.get(id)?.size); }
    catch (error) { pool.dispose(); throw error; }
    let disposed = false;
    const current = {
        pool,
        retry: (key: PdfDocKey) => pool.retry(key),
        dispose() {
            if (disposed) return;
            disposed = true;
            uninstall?.();
            pool.dispose();
            if (active === current) active = undefined;
        },
    };
    active = current;
}

/** Boots the contained broker frame and one render worker at idle, so a vault's first PDF open does not wait for the
 * engine's fetch, compile and init (measured cold: 80-120 ms between the open's request and its first tile request). */
export function warmPdfEngine(): void {
    getSharedPdfPool().warm();
}
