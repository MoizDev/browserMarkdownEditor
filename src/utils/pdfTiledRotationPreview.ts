import type { PdfRotationPicture } from './pdfRotationPreview';

interface PreviewRect { x: number; y: number; width: number; height: number }
interface PreviewPane {
    captureRegion(rect: PreviewRect, maxSide: number, options: {
        layers: readonly string[]; theme: 'light'; inverted: false;
        policy: 'allow-standin'; signal: AbortSignal;
    }): Promise<ImageBitmap>;
}

export interface TiledRotationIdentity {
    readonly sourceHash: string;
    readonly geometryDigest: string;
}

/** A best-effort stand-in, not an authority for the disk turn. Bind the pixels
 * to both the source version and geometry before staging them in PdfPane. */
export async function captureTiledRotationPreview(
    pane: PreviewPane,
    rect: PreviewRect,
    page: number,
    delta: number,
    identity: TiledRotationIdentity,
    current: () => TiledRotationIdentity | null,
): Promise<PdfRotationPicture | undefined> {
    if (!identity.sourceHash || !identity.geometryDigest || !Number.isInteger(page) || page < 0 ||
        (delta !== -90 && delta !== 90) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0) return;
    const valid = () => {
        const now = current();
        return !!now && now.sourceHash === identity.sourceHash && now.geometryDigest === identity.geometryDigest;
    };
    if (!valid()) return;
    const controller = new AbortController();
    let expired = false;
    const task = pane.captureRegion(rect, 768, { layers: ['pdf-page'], theme: 'light', inverted: false,
        policy: 'allow-standin', signal: controller.signal }).then(bitmap => {
        if (expired) { bitmap.close(); return undefined; }
        return bitmap;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => {
        expired = true; controller.abort(); resolve(undefined);
    }, 250); });
    let bitmap: ImageBitmap | undefined;
    try {
        bitmap = await Promise.race([task, deadline]);
        if (!bitmap || !valid()) return;
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.height; canvas.height = bitmap.width;
        try {
            const context = canvas.getContext('2d');
            if (!context) return;
            if (delta > 0) { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
            else { context.translate(0, canvas.height); context.rotate(-Math.PI / 2); }
            context.drawImage(bitmap, 0, 0);
            if (!valid()) return;
            return { page, dataUrl: canvas.toDataURL('image/jpeg', 0.78), width: canvas.width, height: canvas.height };
        } finally { canvas.width = canvas.height = 0; }
    } catch { return; }
    finally {
        expired = true;
        if (timer) clearTimeout(timer);
        controller.abort();
        bitmap?.close();
    }
}
