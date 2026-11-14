import { RENDER_CONSTANTS } from './constants';
import type { BorrowedMirror, MirrorSet, MirrorView } from './mirrorSet';
import { getPlatformRuntime } from './platformRuntime';
import { renderTokenKey } from './tiles/geometry';
import type { RenderToken } from './types';

export interface MirrorVersionBridgeOptions<T extends object> {
    readonly mirrors: MirrorSet<T>;
    readonly from: MirrorView;
    readonly toToken: RenderToken;
    readonly toSourceRole: string;
    /** The caller has checked page count, page size/rotation and appearance before issuing this. */
    readonly geometryDigest: string;
    readonly currentTarget: () => RenderToken | null;
    /** Signals "still updating"; it does not mark stale pixels current. */
    onExpired(): void;
}

export interface MirrorVersionBridge<T extends object> {
    /** Entries remain old-version stand-ins, never exact/capture content. Do not retain after release. */
    read(view: MirrorView): { readonly entries: readonly BorrowedMirror<T>[]; readonly staleVersion: true; readonly sharp: false } | null;
    release(): void;
}

/** A borrow pins the old session's actual tokens, even after its closing barrier moves those bytes
 * to mirror-retiring. This is not a cross-session lease transfer or a new current-version cache.
 */
export function createMirrorVersionBridge<T extends object>(options: MirrorVersionBridgeOptions<T>): MirrorVersionBridge<T> | null {
    const from = options.from;
    const to = { ...options.toToken };
    if (from.token.vaultEpoch !== to.vaultEpoch || from.token.documentId !== to.documentId ||
        from.geometryDigest !== options.geometryDigest || !options.toSourceRole) return null;
    const borrowed = options.mirrors.borrow(from, performance.now());
    const entries = borrowed.read(from);
    if (!entries.length) { borrowed.release(); return null; }
    const targetKey = renderTokenKey(to);
    const deadline = performance.now() + RENDER_CONSTANTS.versionBridgeDurationMs;
    let released = false;
    let cancelDeadline = (): void => {};
    const release = (): void => {
        if (released) return;
        released = true;
        cancelDeadline();
        borrowed.release();
    };
    try {
        cancelDeadline = getPlatformRuntime().scheduler.scheduleDeadline(deadline, () => {
            if (released) return;
            try { release(); } finally { options.onExpired(); }
        });
        if (released) cancelDeadline();
    } catch (error) { release(); throw error; }
    return {
        read(view) {
            if (released) return null;
            if (performance.now() >= deadline) {
                try { release(); } finally { options.onExpired(); }
                return null;
            }
            const current = options.currentTarget();
            if (!current || renderTokenKey(current) !== targetKey || renderTokenKey(view.token) !== targetKey ||
                view.sourceRole !== options.toSourceRole || view.geometryDigest !== options.geometryDigest ||
                view.colourVersion !== from.colourVersion) return null;
            return { entries, staleVersion: true, sharp: false };
        },
        release,
    };
}
