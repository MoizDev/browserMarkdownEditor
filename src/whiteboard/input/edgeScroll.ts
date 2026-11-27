import type { CameraController } from '../../platform/render/camera';
import type { MappingHistory, PresentedMapping } from './pointer';
import type { InputRouter } from './router';
import type { InputToken, Modifiers, RealSample } from './tool';

export interface EdgeScrollOptions {
    readonly surface: HTMLElement;
    readonly camera: CameraController;
    readonly mappings: MappingHistory;
    readonly router: InputRouter<unknown>;
    readonly token: InputToken;
    readonly mac: boolean;
    current(): boolean;
    enabled(): boolean;
    cameraChanged(): void;
    onInputFrame(callback: () => void): () => void;
    invalidate(): void;
}
interface Contact { readonly id: number; readonly coarse: boolean; x: number; y: number; modifiers: Modifiers; sample: RealSample | null }
const EDGE = 8, EDGE_COARSE = 12, DWELL = 200, RAMP = 200, SPEED = 25 * 60, SMALL_SCREEN_PX = 1000, SMALL_SCREEN_SPEED = 0.612;

export class EdgeScroll {
    private contact: Contact | null = null;
    private scheduled = false;
    private readonly unsubscribe: () => void;
    private entered = 0;
    private last = 0;
    private pending: PresentedMapping | null = null;
    private disposed = false;
    constructor(private readonly options: EdgeScrollOptions) {
        const root = options.surface;
        this.unsubscribe = options.onInputFrame(() => {
            if (!this.scheduled || this.disposed) return;
            this.scheduled = false; this.tick(performance.now());
        });
        root.addEventListener('pointerdown', this.down, true);
        root.addEventListener('pointermove', this.move, true);
        root.addEventListener('pointerup', this.up, true);
        root.addEventListener('pointercancel', this.up, true);
        root.addEventListener('lostpointercapture', this.up, true);
        window.addEventListener('keydown', this.key, true);
        window.addEventListener('keyup', this.key, true);
        window.addEventListener('blur', this.blur);
    }
    private modifiers(event: MouseEvent | KeyboardEvent): Modifiers {
        return { shift: event.shiftKey, alt: event.altKey, accel: this.options.mac ? event.metaKey : event.ctrlKey, control: event.ctrlKey };
    }
    private down = (event: PointerEvent): void => {
        if (this.contact) { if (this.contact.id !== event.pointerId) this.stop(); return; }
        if (event.button !== 0) return;
        this.contact = { id: event.pointerId, coarse: event.pointerType !== 'mouse', x: event.clientX, y: event.clientY, modifiers: this.modifiers(event), sample: null };
    };
    private move = (event: PointerEvent): void => {
        const contact = this.contact;
        if (!contact || contact.id !== event.pointerId) return;
        contact.x = event.clientX; contact.y = event.clientY; contact.modifiers = this.modifiers(event);
        if (!event.buttons) { this.stop(); return; }
        this.schedule();
    };
    private up = (event: PointerEvent): void => { if (this.contact?.id === event.pointerId) this.stop(); };
    private key = (event: KeyboardEvent): void => { if (this.contact) this.contact.modifiers = this.modifiers(event); };
    private blur = (): void => { this.stop(); };
    sample(sample: RealSample): void {
        if (!this.contact || sample.pointerId !== this.contact.id || sample.source === 'keyboard') return;
        this.contact.sample = sample; this.schedule();
    }
    private schedule(): void {
        if (!this.scheduled && !this.disposed && this.contact) { this.scheduled = true; this.options.invalidate(); }
    }
    private tick = (now: number): void => {
        const contact = this.contact, { router, token, surface, camera, mappings } = this.options;
        if (!contact || !this.options.current() || !this.options.enabled()) { this.stop(); return; }
        const owner = router.activeOwner;
        if (!owner || !owner.pointerIds.has(contact.id) || (owner.kind !== 'node-edit' && owner.kind !== 'marquee')) { this.entered = 0; this.last = 0; return; }
        const rect = surface.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0) || !contact.sample) { this.entered = 0; this.last = 0; return; }
        const edge = contact.coarse ? EDGE_COARSE : EDGE;
        const axis = (value: number, start: number, end: number) => value < start + edge ? -Math.min(1, (start + edge - value) / EDGE)
            : value > end - edge ? Math.min(1, (value - end + edge) / EDGE) : 0;
        const x = axis(contact.x, rect.left, rect.right), y = axis(contact.y, rect.top, rect.bottom);
        if (!x && !y) { this.entered = 0; this.last = 0; this.pending = null; return; }
        if (!this.entered) { this.entered = now; this.last = now; }
        const presented = mappings.latest();
        if (this.pending && presented && presented !== this.pending) {
            const point = presented.clientToWorld(contact.x, contact.y), local = presented.clientToSurface(contact.x, contact.y);
            if ([point.x, point.y, local.x, local.y].every(Number.isFinite)) {
                const sample: RealSample = { ...contact.sample, x: point.x, y: point.y, surfaceX: local.x, surfaceY: local.y, time: presented.time };
                router.update(token, contact.id, [sample], contact.modifiers);
            }
            this.pending = null;
        }
        const elapsed = Math.max(0, Math.min(50, now - this.last)); this.last = now;
        const linear = Math.min(1, Math.max(0, (now - this.entered - DWELL) / RAMP)), ramp = linear * linear * linear;
        if (ramp && !this.pending && presented) {
            const before = camera.camera;
            const oldX = before.x, oldY = before.y;
            const speedX = rect.width < SMALL_SCREEN_PX ? SMALL_SCREEN_SPEED : 1, speedY = rect.height < SMALL_SCREEN_PX ? SMALL_SCREEN_SPEED : 1;
            camera.panBy({ x: x * SPEED * speedX * ramp * elapsed / 1000, y: y * SPEED * speedY * ramp * elapsed / 1000 });
            if (camera.camera.x !== oldX || camera.camera.y !== oldY) {
                this.pending = presented; this.options.cameraChanged();
            }
        }
        this.schedule();
    };
    private stop(): void {
        this.scheduled = false; this.entered = 0; this.last = 0; this.pending = null; this.contact = null;
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.stop(); this.unsubscribe();
        const root = this.options.surface;
        root.removeEventListener('pointerdown', this.down, true);
        root.removeEventListener('pointermove', this.move, true);
        root.removeEventListener('pointerup', this.up, true);
        root.removeEventListener('pointercancel', this.up, true);
        root.removeEventListener('lostpointercapture', this.up, true);
        window.removeEventListener('keydown', this.key, true);
        window.removeEventListener('keyup', this.key, true);
        window.removeEventListener('blur', this.blur);
    }
}
