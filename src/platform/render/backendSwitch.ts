import type { PaneCompositor, PaneSurfaceHost } from './compositor.types';

export function createPaneSurfaceHost(element: HTMLElement): PaneSurfaceHost {
    let current: HTMLCanvasElement | null = null;
    return Object.freeze({
        attach(canvas: HTMLCanvasElement): void {
            canvas.setAttribute('aria-hidden', 'true');
            if (current === canvas && canvas.parentNode === element) return;
            if (current?.parentNode === element) current.replaceWith(canvas);
            else element.insertBefore(canvas, element.firstChild);
            current = canvas;
        },
        detach(canvas: HTMLCanvasElement): void {
            if (current !== canvas) return;
            current = null;
            if (canvas.parentNode === element) canvas.remove();
        },
    });
}

export class PaneBackendSwitch {
    private selected: PaneCompositor | null = null;
    private candidate: PaneCompositor | null = null;
    private disposed = false;

    constructor(private readonly host: PaneSurfaceHost) {}

    get current(): PaneCompositor | null { return this.selected; }
    get staged(): PaneCompositor | null { return this.candidate; }

    stage(compositor: PaneCompositor): PaneCompositor | null {
        this.ensureLive();
        if (compositor === this.candidate) return null;
        const previous = this.candidate;
        this.candidate = compositor === this.selected ? null : compositor;
        return previous;
    }

    clearStaged(expected?: PaneCompositor): PaneCompositor | null {
        if (expected !== undefined && this.candidate !== expected) return null;
        const previous = this.candidate;
        this.candidate = null;
        return previous;
    }

    select(compositor: PaneCompositor): PaneCompositor | null {
        this.ensureLive();
        if (compositor === this.selected) return null;
        const previous = this.selected;
        if (previous?.surface === compositor.surface) {
            // Canvas identity cannot distinguish two owners during the old owner's
            // detach; replacement instances must not share a displayed canvas.
            throw new Error('A replacement compositor must own a distinct canvas');
        }
        // attach performs one atomic DOM replacement. Detaching first would expose
        // a blank pane; clearing all children would also destroy the input host.
        compositor.attach(this.host);
        this.selected = compositor;
        if (this.candidate === compositor) this.candidate = null;
        previous?.detach();
        return previous;
    }

    detach(expected?: PaneCompositor): PaneCompositor | null {
        if (expected !== undefined && this.selected !== expected) return null;
        const previous = this.selected;
        this.selected = null;
        previous?.detach();
        return previous;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.candidate = null;
        this.detach();
    }

    private ensureLive(): void {
        if (this.disposed) throw new Error('Cannot select a disposed pane surface');
    }
}
