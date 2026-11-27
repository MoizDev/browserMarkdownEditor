import { createMirrorVersionBridge, renderTokenKey } from '../../platform/render';
import type { MirrorVersionBridge, RenderToken } from '../../platform/render';
import type { PageGeometry } from '../../platform/types';
import { createPdfReplyValidators } from '../pool/validation';
import type { PdfMirrorPixels, PdfSessionMirrors } from './tileMirror';

export interface PdfVersionBridge {
    readonly geometryDigest: string;
    readonly source: 'outer' | 'original';
    readonly variant: string;
    readonly target: RenderToken;
    readonly pageCount: number;
    readonly requiredPages: readonly number[];
    readonly geometries: readonly Readonly<PageGeometry>[];
    readonly pixels: MirrorVersionBridge<PdfMirrorPixels>;
    release(): void;
}
const validateGeometry = createPdfReplyValidators().geometry;
const verified = new WeakSet<PdfVersionBridge>();
function geometry(value: Readonly<PageGeometry> | undefined, page: number): Readonly<PageGeometry> | null {
    if (!value) return null;
    try {
        const copy = validateGeometry(value, page);
        return Object.freeze({ ...copy, toUserSpace: Object.freeze([...copy.toUserSpace]) as PageGeometry['toUserSpace'] });
    } catch { return null; }
}
function sameGeometry(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate &&
        a.userUnit === b.userUnit && a.toUserSpace.every((number, index) => number === b.toUserSpace[index]);
}

export function beginPdfVersionBridge(options: {
    readonly previous: PdfSessionMirrors;
    readonly target: RenderToken;
    readonly targetSource: 'outer' | 'original';
    readonly pageCount: number;
    readonly geometry: (page: number) => Readonly<PageGeometry> | undefined;
    readonly currentTarget: () => RenderToken | null;
    readonly onExpired: () => void;
}): PdfVersionBridge | null {
    const from = options.previous.lastView();
    if (!from || !Number.isSafeInteger(options.pageCount) || options.pageCount < 1 || options.pageCount > 100_000 ||
        from.token.vaultEpoch !== options.target.vaultEpoch || from.token.documentId !== options.target.documentId ||
        from.sourceRole !== options.targetSource) return null;
    const borrow = options.previous.mirrors.borrow(from, performance.now());
    try {
        const entries = borrow.read(from), ids = new Set<number>();
        if (!entries.length) return null;
        for (const { entry } of entries) {
            const value = entry.key.pageOrRegion, page = Number(value);
            if (!Number.isSafeInteger(page) || page < 0 || page >= options.pageCount || String(page) !== value) return null;
            ids.add(page);
        }
        const requiredPages = Object.freeze([...ids].sort((a, b) => a - b));
        const geometries: Readonly<PageGeometry>[] = [];
        for (const page of requiredPages) {
            const result = geometry(options.geometry(page), page);
            if (!result) return null;
            geometries.push(result);
        }
        const raw = createMirrorVersionBridge({ mirrors: options.previous.mirrors, from,
            toToken: options.target, toSourceRole: options.targetSource, geometryDigest: from.geometryDigest,
            currentTarget: options.currentTarget, onExpired: options.onExpired });
        if (!raw) return null;
        const target = Object.freeze({ ...options.target }), allowed = new Set(requiredPages);
        const pixels: MirrorVersionBridge<PdfMirrorPixels> = {
            read(view) {
                if (!verified.has(bridge) || view.contentRevision !== from.contentRevision || renderTokenKey(view.token) !== renderTokenKey(target)) return null;
                const result = raw.read(view);
                if (!result) return null;
                if (result.entries.some(({ entry }) => {
                    const page = Number(entry.key.pageOrRegion);
                    return !allowed.has(page) || String(page) !== entry.key.pageOrRegion;
                })) { bridge.release(); return null; }
                return result;
            },
            release: () => raw.release(),
        };
        const bridge: PdfVersionBridge = Object.freeze({ geometryDigest: from.geometryDigest, source: options.targetSource, variant: from.contentRevision,
            target, pageCount: options.pageCount, requiredPages, geometries: Object.freeze(geometries), pixels,
            release: () => { verified.delete(bridge); raw.release(); } });
        return bridge;
    } finally { borrow.release(); }
}

export function finishPdfVersionBridge(options: {
    readonly bridge: PdfVersionBridge | null;
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly variant: string;
    readonly geometryDigest: string;
    readonly pageCount: number;
    readonly geometry: (page: number) => Readonly<PageGeometry> | undefined;
}): PdfVersionBridge | null {
    const bridge = options.bridge;
    if (!bridge) return null;
    const target = bridge.target, token = options.token;
    let matches = false;
    try {
        matches = bridge.geometryDigest === options.geometryDigest && bridge.source === options.source && bridge.variant === options.variant &&
            bridge.pageCount === options.pageCount && target.vaultEpoch === token.vaultEpoch && target.documentId === token.documentId &&
            target.session === token.session && target.bytesGeneration === token.bytesGeneration &&
            bridge.requiredPages.every((page, index) => {
                const value = geometry(options.geometry(page), page);
                return !!value && sameGeometry(bridge.geometries[index], value);
            });
    } catch { matches = false; }
    if (!matches) {
        bridge.release();
        return null;
    }
    verified.add(bridge);
    return bridge;
}
