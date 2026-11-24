import type { PaneCompositor, PaneSurfaceHost } from './compositor.types';

/** Only this host's owned surface is replaced. Input/overlay nodes (and their
 * listeners, pointer capture and focus) must survive a GPU↔2D change (C4.2).
 * Never search for a canvas: an overlay may itself own one.
 */
export function createPaneSurfaceHost(element: HTMLElement): PaneSurfaceHost {
    let current: HTMLCanvasElement | null = null;
    return Object.freeze({
        attach(canvas: HTMLCanvasElement): void {
            // Semantic text and input remain in the host's DOM overlay, not the pixel surface.
            canvas.setAttribute('aria-hidden', 'true');
            if (current === canvas && canvas.parentNode === element) return;
            if (current?.parentNode === element) current.replaceWith(canvas);
            else element.insertBefore(canvas, element.firstChild);
            current = canvas;
        },
        detach(canvas: HTMLCanvasElement): void {
            // The previous compositor detaches AFTER its replacement is attached.
            // Late cleanup must not remove that replacement or a reparented surface.
            if (current !== canvas) return;
            current = null;
            if (canvas.parentNode === element) canvas.remove();
        },
    });
}

/** The attach actor's canonical surface selector. The broker/lifecycle already
 * own loss recovery, reservations and complete-current-frame authorization; this
 * helper adds no competing state machine, context, frame loop or sharpness rule.
 *
 * Stage GPU while the current 2D picture remains attached. Only presenter.selectGpu,
 * called by lifecycle.presentGpu after its guard, selects that candidate. Selecting
 * CPU is immediate and uses its distinct canvas. Compositors, native owners and all
 * layer/session resources remain caller-owned, including superseded candidates.
 */
export class PaneBackendSwitch {
    private selected: PaneCompositor | null = null;
    private candidate: PaneCompositor | null = null;
    private disposed = false;

    constructor(private readonly host: PaneSurfaceHost) {}

    get current(): PaneCompositor | null { return this.selected; }
    get staged(): PaneCompositor | null { return this.candidate; }

    /** Returns a superseded candidate for the actor's compositor-only cleanup. */
    stage(compositor: PaneCompositor): PaneCompositor | null {
        this.ensureLive();
        if (compositor === this.candidate) return null;
        const previous = this.candidate;
        this.candidate = compositor === this.selected ? null : compositor;
        return previous;
    }

    /** A delayed preparation's cleanup cannot clear a newer prepared candidate. */
    clearStaged(expected?: PaneCompositor): PaneCompositor | null {
        if (expected !== undefined && this.candidate !== expected) return null;
        const previous = this.candidate;
        this.candidate = null;
        return previous;
    }

    /** Return the detached compositor, never dispose it or its session resources. */
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

    /** Identity guard also protects a replacement from an old view's teardown. */
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
