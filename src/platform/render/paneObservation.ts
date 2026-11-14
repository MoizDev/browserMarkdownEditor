import { cssFallbackBox, devicePixelBox } from './surfaceMetrics';
import type { PhysicalBox } from './surfaceMetrics';

export interface PaneSizeObservation {
    readonly generation: number;
    readonly physical: PhysicalBox;
    readonly nominalDpr: number;
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly contentX: number;
    readonly contentY: number;
    readonly writingMode: string;
}

interface ContentBox {
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
}

/** Records only; metrics commits backing sizes later in the shared frame (§3.2:331–345). */
export class PaneSizeObserver {
    private host: HTMLElement | null;
    private observer: ResizeObserver | null = null;
    private media: MediaQueryList | null = null;
    private mediaDpr: number | null = null;
    private view: Window | null = null;
    private active = false;
    private content: ContentBox | null = null;
    private value: PaneSizeObservation | null = null;
    private generation = 0;
    private pending = false;
    private frameId = -1;
    private frameValue: PaneSizeObservation | null = null;
    private readingFrame = false;

    constructor(host: HTMLElement, private readonly onSize: (size: PaneSizeObservation) => void,
        private readonly onError: (error: unknown) => void) {
        this.host = host;
    }

    /** Latest reported geometry; onSize wakes the actor but may report this batch more than once. */
    get current(): PaneSizeObservation | null { return this.value; }

    /** Called by commitMetrics on an already-needed shared frame, never by a private poll/rAF.
     * RO/media/window notifications share one generation until this read consumes their batch.
     * A repeated read freezes the same observation even if synchronous callbacks report more.
     */
    readForFrame(frameId: number): PaneSizeObservation | null {
        if (!Number.isSafeInteger(frameId) || frameId < 0 || frameId < this.frameId) {
            throw new RangeError('Geometry frame ids must be monotonic nonnegative integers');
        }
        if (!this.active) return null;
        if (frameId === this.frameId) return this.frameValue;
        // onSize may synchronously reenter this reader while a DPR check publishes.
        this.frameId = frameId;
        this.frameValue = this.value;
        this.readingFrame = true;
        try { this.checkDpr(); }
        finally { this.readingFrame = false; }
        this.frameValue = this.value;
        this.pending = false;
        return this.frameValue;
    }

    start(): void {
        if (this.active) return;
        if (!this.host) throw new Error('Cannot restart a disposed size observer');
        this.view = this.host.ownerDocument.defaultView;
        if (!this.view) throw new Error('A platform pane requires a browsing context');
        this.active = true;
        try {
            this.observer = new ResizeObserver(entries => {
                if (!this.active || !this.host) return;
                for (const entry of entries) {
                    if (entry.target !== this.host) continue;
                    try { this.record(entry); } catch (error) { this.onError(error); }
                }
            });
            this.observe();
            this.armDpr();
            this.view.addEventListener('resize', this.checkDpr);
            this.view.addEventListener('pageshow', this.returned);
            this.host.ownerDocument.addEventListener('visibilitychange', this.returned);
        } catch (error) { this.dispose(); throw error; }
    }

    /** Force a fresh native observation, not a transformed getBoundingClientRect measurement. */
    refresh(): void {
        if (!this.active || !this.host || !this.observer) return;
        this.observer.unobserve(this.host);
        this.observe();
    }

    dispose(): void {
        if (!this.active && !this.host) return;
        this.active = false;
        this.observer?.disconnect();
        this.observer = null;
        this.media?.removeEventListener('change', this.dprChanged);
        this.media = null;
        this.mediaDpr = null;
        this.view?.removeEventListener('resize', this.checkDpr);
        this.view?.removeEventListener('pageshow', this.returned);
        this.host?.ownerDocument.removeEventListener('visibilitychange', this.returned);
        this.view = null;
        this.host = null;
        this.content = null;
        this.value = null;
        this.frameValue = null;
        this.pending = false;
    }

    private observe(): void {
        if (!this.host || !this.observer) return;
        try { this.observer.observe(this.host, { box: 'device-pixel-content-box' }); }
        catch { this.observer.observe(this.host, { box: 'content-box' }); }
    }

    private nominalDpr(): number {
        const dpr = this.view?.devicePixelRatio;
        if (dpr === undefined || !Number.isFinite(dpr) || dpr <= 0) throw new RangeError('Invalid device pixel ratio');
        return dpr;
    }

    private record(entry: ResizeObserverEntry): void {
        if (!this.host || !this.view) return;
        if (entry.contentBoxSize?.length > 1) throw new RangeError('A canvas pane must not fragment');
        const content = { width: entry.contentRect.width, height: entry.contentRect.height,
            x: entry.contentRect.x, y: entry.contentRect.y };
        if (!Object.values(content).every(Number.isFinite) || content.width < 0 || content.height < 0) {
            throw new RangeError('Invalid pane content box');
        }
        const dpr = this.nominalDpr();
        const mode = this.view.getComputedStyle(this.host).writingMode;
        const vertical = mode.startsWith('vertical') || mode.startsWith('sideways');
        const fragments = entry.devicePixelContentBoxSize;
        const physical = fragments?.length ? devicePixelBox(fragments, vertical ? 'vertical' : 'horizontal') :
            cssFallbackBox(content.width, content.height, dpr);
        // Do not let a rejected fragmented/device-box entry become the next DPR fallback.
        this.content = content;
        if (this.mediaDpr !== dpr) this.armDpr();
        this.publish(physical, dpr, content, mode);
    }

    private publish(physical: PhysicalBox, nominalDpr: number, content: ContentBox, writingMode: string): void {
        const previous = this.value;
        if (previous && previous.physical.width === physical.width && previous.physical.height === physical.height &&
            previous.physical.fallbackSizing === physical.fallbackSizing && previous.nominalDpr === nominalDpr &&
            previous.contentX === content.x && previous.contentY === content.y && previous.writingMode === writingMode) return;
        const cssWidth = physical.width / nominalDpr;
        const cssHeight = physical.height / nominalDpr;
        if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) throw new RangeError('Invalid canonical pane extent');
        if (!this.pending) this.generation++;
        this.pending = true;
        const value = Object.freeze({ generation: this.generation, physical: Object.freeze({ ...physical }), nominalDpr,
            cssWidth, cssHeight, contentX: content.x, contentY: content.y, writingMode });
        this.value = value;
        if (this.readingFrame) this.frameValue = value;
        this.onSize(value);
    }

    private armDpr(): void {
        this.media?.removeEventListener('change', this.dprChanged);
        this.mediaDpr = this.nominalDpr();
        this.media = this.view?.matchMedia(`(resolution: ${this.mediaDpr}dppx)`) ?? null;
        this.media?.addEventListener('change', this.dprChanged);
    }

    private readonly dprChanged = (): void => {
        if (!this.active || !this.host || !this.view) return;
        try {
            const dpr = this.nominalDpr();
            // Media can arrive before OR after RO. Estimate only in the former case;
            // a late media event must never downgrade an already exact new-DPR box.
            if (this.content && this.value?.nominalDpr !== dpr) {
                this.publish(cssFallbackBox(this.content.width, this.content.height, dpr), dpr,
                    this.content, this.view.getComputedStyle(this.host).writingMode);
            }
            this.armDpr();
            this.refresh();
        } catch (error) { this.onError(error); }
    };

    private readonly checkDpr = (): void => {
        if (!this.active) return;
        try { if (this.mediaDpr !== this.nominalDpr()) this.dprChanged(); }
        catch (error) { this.onError(error); }
    };

    private readonly returned = (): void => {
        if (!this.active || this.host?.ownerDocument.hidden) return;
        this.checkDpr();
        this.refresh();
    };
}
