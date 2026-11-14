import { createMirrorVersionBridge } from '../../platform/render';
import type { MirrorVersionBridge, RenderToken } from '../../platform/render';
import type { PlatformSessionSlots } from '../../platform/render/createPlatformMirrors';
import type { PdfMirrorPixels, PdfSessionMirrors } from './tileMirror';

const bridgeSlot = Symbol('PDF previous-version bridge');

export interface PdfVersionBridge {
    readonly geometryDigest: string;
    readonly source: 'outer' | 'original';
    readonly variant: string;
    readonly target: RenderToken;
    readonly pixels: MirrorVersionBridge<PdfMirrorPixels>;
    release(): void;
}

/**
 * Called before the old PDF session closes, while its last committed mirror can still be borrowed.
 * The App identity slot survives byte reloads, and owns the borrowed old-session lease (C1.3).
 */
export function beginPdfVersionBridge(options: {
    readonly appSlots: PlatformSessionSlots;
    readonly previous: PdfSessionMirrors;
    readonly target: RenderToken;
    readonly targetSource: 'outer' | 'original';
    readonly currentTarget: () => RenderToken | null;
    readonly onExpired: () => void;
}): PdfVersionBridge | null {
    const from = options.previous.lastView();
    if (!from || from.token.vaultEpoch !== options.target.vaultEpoch ||
        from.token.documentId !== options.target.documentId || from.token.session !== options.target.session ||
        from.sourceRole !== options.targetSource) return null;
    const pixels = createMirrorVersionBridge({ mirrors: options.previous.mirrors, from,
        toToken: options.target, toSourceRole: options.targetSource, geometryDigest: from.geometryDigest,
        currentTarget: options.currentTarget, onExpired: options.onExpired });
    if (!pixels) return null;
    const bridge: PdfVersionBridge = {
        geometryDigest: from.geometryDigest, source: options.targetSource, variant: from.contentRevision,
        target: { ...options.target }, pixels, release: () => pixels.release(),
    };
    try { options.appSlots.setSlot(bridgeSlot, bridge, value => value.release()); }
    catch (error) { bridge.release(); throw error; }
    return bridge;
}

/** Geometry is available only after the new pool opens; incompatible pages never reuse old pixels. */
export function finishPdfVersionBridge(options: {
    readonly appSlots: PlatformSessionSlots;
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly variant: string;
    readonly geometryDigest: string;
}): PdfVersionBridge | null {
    const bridge = options.appSlots.getSlot<PdfVersionBridge>(bridgeSlot);
    if (!bridge) return null;
    const target = bridge.target, token = options.token;
    if (bridge.geometryDigest !== options.geometryDigest || bridge.source !== options.source || bridge.variant !== options.variant ||
        target.vaultEpoch !== token.vaultEpoch || target.documentId !== token.documentId ||
        target.session !== token.session || target.bytesGeneration !== token.bytesGeneration) {
        bridge.release();
        return null;
    }
    return bridge;
}
