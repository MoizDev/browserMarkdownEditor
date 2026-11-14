import { createPlatformMirrors, pagePresentation } from '../../platform/render';
import type { BorrowedMirror, ByteLease, MirrorEntry, MirrorView, Rect, RenderToken, ViewState } from '../../platform/render';
import type { CompositorMirrorQuad } from '../../platform/render/compositor.types';
import type { MirrorSet } from '../../platform/render/mirrorSet';
import type { TileKey } from '../../platform/render/tiles/geometry';

/** Pixels and placement belong to the document session, not the transient page layer. */
export interface PdfMirrorPixels {
    readonly bitmap: ImageBitmap;
    readonly world: Readonly<Rect>;
    readonly source: Readonly<Rect>;
    readonly page: Readonly<Rect>;
}

export interface PdfMirrorPublish {
    readonly token: RenderToken;
    readonly key: TileKey;
    readonly geometryDigest: string;
    readonly tier: 'exact' | 'low';
    readonly neededByCurrentFrame: boolean;
    readonly pixels: PdfMirrorPixels;
    readonly lease: ByteLease;
}

export interface PdfSessionMirrors {
    readonly mirrors: MirrorSet<PdfMirrorPixels>;
    remember(view: MirrorView): void;
    lastView(): MirrorView | null;
    publish(input: PdfMirrorPublish): string | null;
    mirrorQuad(item: BorrowedMirror<PdfMirrorPixels>, view: MirrorView): CompositorMirrorQuad;
}

const slot = Symbol('PDF session mirror storage');

/** Session slots keep both pixels and the platform mirror across hide and graph unmount (§8:193–204). */
export function getPdfSessionMirrors(options: {
    readonly session: {
        getSlot<T>(key: symbol): T | undefined;
        setSlot<T>(key: symbol, value: T, dispose?: () => void): void;
    };
    readonly token: RenderToken;
    readonly currentToken: () => RenderToken | null;
}): PdfSessionMirrors {
    const existing = options.session.getSlot<PdfSessionMirrors>(slot);
    if (existing) return existing;
    const pixels = new Map<string, PdfMirrorPixels>();
    let nextId = 0;
    let lastView: MirrorView | null = null;
    const storage = {
        read: (id: string) => pixels.get(id),
        close: (id: string) => {
            const value = pixels.get(id);
            if (!value) return;
            pixels.delete(id);
            value.bitmap.close();
        },
    };
    const session = {
        getSlot: <T>(key: symbol) => options.session.getSlot<T>(key),
        setSlot: <T>(key: symbol, value: T, dispose?: (value: T) => void) =>
            options.session.setSlot(key, value, dispose ? () => dispose(value) : undefined),
    };
    const mirrors = createPlatformMirrors({ session, owner: options.token,
        currentToken: options.currentToken, storage });
    const result = {
        mirrors,
        remember(view: MirrorView): void {
            lastView = { ...view, token: { ...view.token },
                view: { camera: { ...view.view.camera }, viewport: { ...view.view.viewport } } };
        },
        lastView: () => lastView,
        /** On success the mirror owns pixels and lease; on refusal both remain with the caller. */
        publish(input: PdfMirrorPublish): string | null {
            if (input.lease.bytes !== input.pixels.bitmap.width * input.pixels.bitmap.height * 4) {
                throw new RangeError('PDF mirror lease does not cover its bitmap');
            }
            const id = `pdf-mirror:${++nextId}`;
            const entry: MirrorEntry = { id, key: input.key, geometryDigest: input.geometryDigest,
                tier: input.tier, bytes: input.lease.bytes, neededByCurrentFrame: input.neededByCurrentFrame };
            pixels.set(id, input.pixels);
            try {
                if (mirrors.adopt(entry, input.token, input.lease)) return id;
            } catch (error) {
                pixels.delete(id);
                throw error;
            }
            pixels.delete(id);
            return null;
        },
        /** The compositor consumes device-pixel destinations for the identical frozen view. */
        mirrorQuad(item: BorrowedMirror<PdfMirrorPixels>, view: MirrorView): CompositorMirrorQuad {
            const { bitmap, world, source, page } = item.pixels;
            const { camera, viewport } = view.view;
            const scale = camera.z * viewport.dpr;
            const moving = (view.view as Partial<ViewState>).moving ?? false;
            const offset = pagePresentation(page, { ...view.view, epoch: 0, moving }).restOffsetDevice;
            return { image: bitmap, sourceRect: source,
                destRect: { x: (world.x - camera.x) * scale + offset.x, y: (world.y - camera.y) * scale + offset.y,
                    width: world.width * scale, height: world.height * scale } };
        },
    };
    options.session.setSlot(slot, result);
    return result;
}

