import type { CameraController, Point } from '../../platform/render/camera';
import type { BoardDoc } from '../model/doc';
import { stepBoardZoom } from './cameraZoom';

interface Tap { readonly point: Point; readonly time: number }
interface Contact extends Tap { readonly id: number; moved: boolean }
export interface TouchDoubleTapOptions {
    readonly doc: BoardDoc;
    readonly camera: CameraController;
    eligible(): boolean;
    changed(): void;
}

/** Hand-tool double tap is a camera command, never two synthetic mouse clicks.
 * A rejected palm or a second contact poisons the entire in-progress pair. */
export class TouchDoubleTap {
    private readonly contacts = new Set<number>();
    private active: Contact | null = null;
    private previous: Tap | null = null;
    private disposed = false;
    constructor(private readonly options: TouchDoubleTapOptions) {}
    down(id: number, point: Point, time: number, admitted: boolean): void {
        if (this.disposed || !Number.isFinite(time) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { this.clear(); return; }
        this.contacts.add(id);
        if (!admitted || !this.options.eligible() || this.contacts.size !== 1) { this.active = null; this.previous = null; return; }
        this.active = { id, point: { ...point }, time, moved: false };
    }
    move(id: number, point: Point): void {
        const active = this.active;
        if (!active || active.id !== id) return;
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.hypot(point.x - active.point.x, point.y - active.point.y) > 12) {
            active.moved = true; this.previous = null;
        }
    }
    up(id: number, point: Point, time: number, cancelled = false): boolean {
        this.contacts.delete(id);
        const active = this.active;
        if (!active || active.id !== id) return false;
        this.active = null;
        if (cancelled || active.moved || this.contacts.size || !this.options.eligible() || !Number.isFinite(time)
            || time < active.time || time - active.time > 400 || !Number.isFinite(point.x) || !Number.isFinite(point.y)
            || Math.hypot(point.x - active.point.x, point.y - active.point.y) > 12) {
            this.previous = null; return false;
        }
        const previous = this.previous;
        if (previous && time >= previous.time && time - previous.time <= 350
            && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= 24) {
            this.previous = null;
            const target = stepBoardZoom(this.options.doc, this.options.camera, 1);
            this.options.camera.zoomTo(target, point); this.options.changed(); return true;
        }
        this.previous = { point: { ...point }, time }; return false;
    }
    clear(): void { this.contacts.clear(); this.active = null; this.previous = null; }
    dispose(): void { this.disposed = true; this.clear(); }
}
