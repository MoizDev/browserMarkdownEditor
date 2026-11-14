import type { Rect, ViewState } from '../../platform/render';
import type { PdfPageLink, PdfLinkTarget } from '../pdfLinkModel';

interface LinkNode { element: HTMLAnchorElement | HTMLButtonElement; page: number; bounds: Rect }

/** Native links sit in the pane's overlay, above PDF pixels. The engine has
 * already mapped every polygon into the rotated page frame; never reinterpret
 * PDF user coordinates or merge separate QuadPoints into one hit box. */
export class PdfLinkOverlay {
    private readonly pages = new Map<number, LinkNode[]>();
    private selecting = false;
    private view: ViewState | null = null;
    private rects: readonly Readonly<Rect>[] = [];

    constructor(private readonly root: HTMLElement,
        private readonly navigate: (target: Exclude<PdfLinkTarget, { kind: 'uri' }>) => void) {}

    setPage(page: number, links: readonly PdfPageLink[]): void {
        this.removePage(page);
        const nodes: LinkNode[] = [];
        for (const link of links) for (const region of link.regions) {
            const xs = region.map(point => point.x), ys = region.map(point => point.y);
            const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
            if (!(width > 0 && height > 0)) continue;
            const element = link.target.kind === 'uri' ? document.createElement('a') : document.createElement('button');
            if (link.target.kind === 'uri' && element instanceof HTMLAnchorElement) {
                element.href = link.target.uri;
                element.target = '_blank';
                element.rel = 'noopener noreferrer';
                element.setAttribute('aria-label', 'Open PDF link');
            } else if (link.target.kind !== 'uri' && element instanceof HTMLButtonElement) {
                const target = link.target;
                element.type = 'button';
                element.setAttribute('aria-label', 'Follow PDF link');
                element.addEventListener('click', () => this.navigate(target));
            }
            element.className = 'pdf-tiled-link';
            element.style.position = 'absolute';
            element.style.clipPath = `polygon(${region.map(point => `${(point.x - x) / width * 100}% ${(point.y - y) / height * 100}%`).join(',')})`;
            element.style.pointerEvents = this.selecting ? 'none' : 'auto';
            this.root.appendChild(element);
            nodes.push({ element, page, bounds: { x, y, width, height } });
        }
        this.pages.set(page, nodes);
        if (this.view) this.position(nodes, this.view);
    }

    setView(view: ViewState, pageRects: readonly Readonly<Rect>[]): void {
        this.view = view;
        this.rects = pageRects;
        for (const nodes of this.pages.values()) this.position(nodes, view);
    }

    setSelecting(selecting: boolean): void {
        this.selecting = selecting;
        for (const nodes of this.pages.values()) for (const { element } of nodes) element.style.pointerEvents = selecting ? 'none' : 'auto';
    }

    removePage(page: number): void {
        for (const { element } of this.pages.get(page) ?? []) element.remove();
        this.pages.delete(page);
    }

    destroy(): void {
        for (const page of this.pages.keys()) this.removePage(page);
        this.view = null; this.rects = [];
    }

    private position(nodes: readonly LinkNode[], view: ViewState): void {
        for (const { element, page, bounds } of nodes) {
            const rect = this.rects[page];
            if (!rect) { element.hidden = true; continue; }
            element.hidden = false;
            element.style.left = `${(rect.x + bounds.x - view.camera.x) * view.camera.z}px`;
            element.style.top = `${(rect.y + bounds.y - view.camera.y) * view.camera.z}px`;
            element.style.width = `${bounds.width * view.camera.z}px`;
            element.style.height = `${bounds.height * view.camera.z}px`;
        }
    }
}
