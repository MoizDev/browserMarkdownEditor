import { ExportTooLarge } from './png';
import type { PinExportSnapshot } from './snapshot';
import { exportSnapshotPng, type SnapshotExportBounds } from './snapshotExport';

export interface ClipboardPngExport {
    readonly items: { readonly 'image/png': Promise<Blob>; readonly 'web image/x-board+png': Promise<Blob> };
    readonly scale: number;
    readonly reduced: boolean;
}

/** The app can construct ClipboardItem synchronously with these promises under user activation. */
export function createClipboardPngExport(pin: PinExportSnapshot, world: SnapshotExportBounds['world'], signal: AbortSignal,
    background?: string): ClipboardPngExport {
    const frozen = { ...world };
    if (![frozen.x, frozen.y, frozen.width, frozen.height].every(Number.isFinite) || frozen.width <= 0 || frozen.height <= 0)
        throw new RangeError('Invalid clipboard capture bounds');
    const scale = Math.min(2, 8192 / frozen.width, 8192 / frozen.height,
        Math.sqrt(2 ** 28 / frozen.width / frozen.height));
    if (!Number.isFinite(scale) || scale <= 0) throw new ExportTooLarge(0);
    // Leave a fraction below the side limit when ceil(width * scale) would otherwise cross it.
    const adjusted = Math.min(scale, (8192 - 1e-7) / frozen.width, (8192 - 1e-7) / frozen.height);
    const png = exportSnapshotPng(pin, { world: frozen, scale: adjusted }, signal, { background, clipboard: true });
    return { items: { 'image/png': png, 'web image/x-board+png': png }, scale: adjusted, reduced: adjusted < 2 - 1e-9 };
}
