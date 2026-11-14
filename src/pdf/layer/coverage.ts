import { pageAt } from '../../platform/render';
import type { BorrowedMirror, LayerCoverage, MirrorView, PageStack, Rect } from '../../platform/render';
import type { PdfMirrorPixels } from './tileMirror';

export function intersects(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Rectangle union, not its bounding box: a missing tile is still a hole (design §6.3:646). */
export function covers(target: Readonly<Rect>, boxes: readonly Readonly<Rect>[]): boolean {
    const cuts = [target.x, target.x + target.width];
    for (const box of boxes) {
        if (!intersects(box, target)) continue;
        cuts.push(Math.max(target.x, box.x), Math.min(target.x + target.width, box.x + box.width));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
        if (cuts[i] <= cuts[i - 1]) continue;
        const x = (cuts[i] + cuts[i - 1]) / 2;
        const intervals = boxes.filter(box => box.x <= x && box.x + box.width >= x)
            .map(box => [Math.max(target.y, box.y), Math.min(target.y + target.height, box.y + box.height)] as const)
            .filter(([top, bottom]) => bottom > top).sort((a, b) => a[0] - b[0]);
        let end = target.y;
        for (const [top, bottom] of intervals) { if (top > end + 1e-7) break; end = Math.max(end, bottom); }
        if (end < target.y + target.height - 1e-7) return false;
    }
    return true;
}

/** A mirror is sharp only where exact copies cover every visible page rectangle. */
export function pdfMirrorCoverage(stack: Readonly<PageStack>, view: MirrorView,
    drawn: readonly BorrowedMirror<PdfMirrorPixels>[]): LayerCoverage {
    const { camera, viewport } = view.view;
    const area = { x: camera.x, y: camera.y, width: viewport.width / camera.z, height: viewport.height / camera.z };
    const all = drawn.map(item => item.pixels.world);
    const exact = drawn.filter(item => item.entry.tier === 'exact').map(item => item.pixels.world);
    let complete = true, sharp = true;
    for (let page = Math.max(0, pageAt(stack, area.y)); page < stack.rects.length; page++) {
        const rect = stack.rects[page];
        if (rect.y >= area.y + area.height) break;
        const x = Math.max(rect.x, area.x), y = Math.max(rect.y, area.y);
        const right = Math.min(rect.x + rect.width, area.x + area.width);
        const bottom = Math.min(rect.y + rect.height, area.y + area.height);
        if (right <= x || bottom <= y) continue;
        const target = { x, y, width: right - x, height: bottom - y };
        if (!covers(target, all)) complete = false;
        if (!covers(target, exact)) sharp = false;
    }
    return { complete, sharp: complete && sharp };
}
