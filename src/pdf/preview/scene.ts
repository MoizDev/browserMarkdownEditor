import type { ViewState } from '../../platform/render';
import { PreviewBitmapLayer } from './bitmapLayer';
import type { PreviewExpectedPage } from './bitmapLayer';
import type { PreviewRect, PreviewSnapshot } from '../../utils/pdfPreviewTypes';

interface Request {
    readonly key: string;
    readonly interest: PreviewRect;
    readonly canvas: HTMLCanvasElement;
}

function contains(outer: PreviewRect, inner: PreviewRect): boolean {
    return outer.x <= inner.x && outer.y <= inner.y
        && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

function intersect(a: PreviewRect, b: PreviewRect): PreviewRect | null {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Updates only from viewer events and bitmap completions; it never starts an animation loop. */
export class PreviewScene {
    private readonly requests = new Map<number, Request>();
    private visible = true;
    private disposed = false;
    private sceneRevision = 0;
    private snapshotValue: PreviewSnapshot | null = null;

    constructor(readonly layer: PreviewBitmapLayer, private readonly invalidate: () => void) {}

    get revision(): number { return this.sceneRevision + this.layer.bitmaps.revision; }
    get snapshot(): PreviewSnapshot | null { return this.snapshotValue; }

    sync(snapshot: PreviewSnapshot | null): void {
        if (this.disposed || !this.visible) return;
        if (!snapshot) {
            this.snapshotValue = null;
            this.requests.clear();
            this.layer.setExpected(new Map());
            this.sceneRevision++;
            this.invalidate();
            return;
        }
        this.snapshotValue = snapshot;
        this.sceneRevision++;
        const view = snapshot.camera;
        const viewport: PreviewRect = {
            x: view.x, y: view.y,
            width: snapshot.scroll.clientWidth / view.z, height: snapshot.scroll.clientHeight / view.z,
        };
        const margin = { x: viewport.x - viewport.width / 4, y: viewport.y - viewport.height / 4,
            width: viewport.width * 1.5, height: viewport.height * 1.5 };
        const expected = new Map<number, PreviewExpectedPage>();
        const live = new Set<number>();
        for (const page of snapshot.pages) {
            live.add(page.index);
            const key = page.rasterKey === null ? '' : JSON.stringify([page.rasterKey, page.canvasRect]);
            expected.set(page.index, { rect: page.pageRect, key });
            if (!page.canvas || !page.rasterKey) continue;
            const needed = intersect(viewport, page.pageRect);
            const interest = intersect(margin, page.canvasRect);
            if (!needed || !interest) continue;
            const current = this.layer.bitmaps.entries.get(page.index);
            if (current?.key === key && current.tiles.length) {
                const first = current.tiles[0].destination;
                const last = current.tiles[current.tiles.length - 1].destination;
                const available = { x: first.x, y: first.y, width: last.x + last.width - first.x, height: last.y + last.height - first.y };
                if (contains(available, needed)) continue;
            }
            const request = this.requests.get(page.index);
            if (request?.canvas === page.canvas && request.key === key && contains(request.interest, needed)) continue;
            const next = { key, interest, canvas: page.canvas };
            this.requests.set(page.index, next);
            void this.layer.bitmaps.publish(page.index, key, page.canvas, page.canvasRect,
                () => !this.disposed && this.visible && this.requests.get(page.index) === next && page.current(), interest)
                .then(copied => {
                    if (copied || this.requests.get(page.index) !== next || !page.current()) return;
                    // Replacement can exceed the grant while the old crop is still held.
                    // Fall back to the classic canvas, free it and retry once without it.
                    if (!this.layer.bitmaps.entries.has(page.index)) return;
                    this.requests.delete(page.index);
                    this.layer.bitmaps.remove(page.index);
                    this.sync(this.snapshotValue);
                })
                .catch(error => console.error('Could not copy PDF platform preview:', error))
                .finally(() => { if (this.requests.get(page.index) === next) this.requests.delete(page.index); });
        }
        for (const index of this.layer.bitmaps.entries.keys()) if (!live.has(index)) this.layer.bitmaps.remove(index);
        for (const index of this.requests.keys()) if (!live.has(index)) this.requests.delete(index);
        this.layer.setExpected(expected);
        this.invalidate();
    }

    coverage(view: ViewState, gpu: boolean): { complete: boolean; sharp: boolean } {
        if (!this.visible || !this.snapshotValue) return { complete: false, sharp: false };
        return this.layer.coverage(view, gpu);
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible;
        if (!visible) {
            this.requests.clear();
            this.snapshotValue = null;
            this.layer.bitmaps.setVisible(false);
        } else this.layer.bitmaps.setVisible(true);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.requests.clear();
        this.snapshotValue = null;
    }
}
