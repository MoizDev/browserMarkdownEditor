import { createPdfWorkerBroker } from '../contained/broker';
import { createPdfPool } from '../pool/pool';
import { installTiledPdfPool } from './installPool';
import type { PdfFocusLease } from './startup.types';

const focused = new Map<string, Set<object>>();
let active: { dispose(): void } | undefined;

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
    let current: { dispose(): void } | undefined;
    const broker = createPdfWorkerBroker(() => { if (active === current) current?.dispose(); });
    const pool = createPdfPool({ broker });
    let uninstall: (() => void) | undefined;
    try { uninstall = installTiledPdfPool(pool, id => !!focused.get(id)?.size); }
    catch (error) { pool.dispose(); throw error; }
    let disposed = false;
    current = {
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
