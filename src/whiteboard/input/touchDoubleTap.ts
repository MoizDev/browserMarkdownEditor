import type { Point } from '../../platform/render/camera';

interface Tap { readonly point: Point; readonly time: number }
interface Contact extends Tap { readonly id: number; moved: boolean }
export interface TouchDoubleTapOptions {
    eligible(): boolean;
    zoomIn(point: Point): void;
    changed(): void;
}

const DOUBLE_TAP_MS = 350, DOUBLE_TAP_PX = 24, TAP_SLOP_PX = 12, TAP_MAX_MS = 400;
export class TouchDoubleTap {
    private readonly contacts = new Set<number>();
    private active: Contact | null = null;
    private previous: Tap | null = null;
    private armed: number | null = null;
    private claimed: number | null = null;
    private disposed = false;
    constructor(private readonly options: TouchDoubleTapOptions) {}
    down(id: number, point: Point, time: number, admitted: boolean): void {
        if (this.disposed || !Number.isFinite(time) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { this.clear(); return; }
        this.contacts.add(id);
        if (!admitted || !this.options.eligible() || this.contacts.size !== 1) { this.active = null; this.previous = null; this.armed = null; return; }
        this.active = { id, point: { ...point }, time, moved: false };
        const previous = this.previous;
        this.armed = previous && time >= previous.time && time - previous.time <= DOUBLE_TAP_MS
            && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_TAP_PX ? id : null;
    }
    claimHold(id: number): boolean {
        if (this.armed !== id || this.active?.id !== id) return false;
        this.armed = null; this.previous = null; this.claimed = id;
        return true;
    }
    move(id: number, point: Point): void {
        const active = this.active;
        if (!active || active.id !== id) return;
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.hypot(point.x - active.point.x, point.y - active.point.y) > TAP_SLOP_PX) {
            active.moved = true; this.previous = null;
        }
    }
    up(id: number, point: Point, time: number, cancelled = false): boolean {
        this.contacts.delete(id);
        const active = this.active;
        if (!active || active.id !== id) return false;
        this.active = null;
        if (this.claimed === id) { this.claimed = null; return false; }
        if (cancelled || active.moved || this.contacts.size || !this.options.eligible() || !Number.isFinite(time)
            || time < active.time || time - active.time > TAP_MAX_MS || !Number.isFinite(point.x) || !Number.isFinite(point.y)
            || Math.hypot(point.x - active.point.x, point.y - active.point.y) > TAP_SLOP_PX) {
            this.previous = null; return false;
        }
        this.previous = { point: { ...point }, time };
        return false;
    }
    clear(): void { this.contacts.clear(); this.active = null; this.previous = null; this.armed = null; this.claimed = null; }
    dispose(): void { this.disposed = true; this.clear(); }
}
