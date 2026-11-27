import type { Affine, Camera, Rect, Viewport, ViewState } from '../types';
import { pageAt } from './pageStack';
import type { PageStack } from './pageStack';

export interface Point { x: number; y: number }

export interface ZoomLimits { min: number; max: number }
export interface ViewportInsets { left: number; right: number; top: number; bottom: number }
export interface OriginBounds { minX: number; maxX: number; minY: number; maxY: number }
export interface CameraAnchor { world: Point; surface: Point }
export interface PagedPosition { page: number; offset: number; zoom: number }

export interface CameraConstraint {
    clampZoom(z: number, viewport: Viewport): number;
    bounds(camera: Camera, viewport: Viewport): OriginBounds;
    resize(camera: Camera, previous: Viewport, next: Viewport): Camera;
    allowsHorizontalPan(camera: Camera, viewport: Viewport): boolean;
}

const unbounded: OriginBounds = Object.freeze({ minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity });
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }

function validateViewport(viewport: Viewport): void {
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
        viewport.width < 0 || viewport.height < 0 || !positive(viewport.dpr)) {
        throw new RangeError('Viewport dimensions must be finite/nonnegative and DPR positive');
    }
}

function validateCamera(camera: Camera, viewport: Viewport): void {
    if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !positive(camera.z) ||
        !positive(camera.z * viewport.dpr) || !Number.isFinite(camera.x * camera.z * viewport.dpr) ||
        !Number.isFinite(camera.y * camera.z * viewport.dpr)) {
        throw new RangeError('Camera and its device transform must be finite with positive scale');
    }
}

function validateLimits(limits: ZoomLimits): void {
    if (!positive(limits.min) || !positive(limits.max) || limits.min > limits.max) {
        throw new RangeError('Zoom limits must be positive, finite and ordered');
    }
}

export function worldToSurface(point: Point, camera: Camera): Point {
    return { x: (point.x - camera.x) * camera.z, y: (point.y - camera.y) * camera.z };
}

export function surfaceToWorld(point: Point, camera: Camera): Point {
    return { x: camera.x + point.x / camera.z, y: camera.y + point.y / camera.z };
}

export function surfaceToDevice(point: Point, viewport: Viewport): Point {
    return { x: point.x * viewport.dpr, y: point.y * viewport.dpr };
}

export function deviceToSurface(point: Point, viewport: Viewport): Point {
    return { x: point.x / viewport.dpr, y: point.y / viewport.dpr };
}

export function worldToDevice(point: Point, view: ViewState): Point {
    return surfaceToDevice(worldToSurface(point, view.camera), view.viewport);
}

export function deviceToWorld(point: Point, view: ViewState): Point {
    return surfaceToWorld(deviceToSurface(point, view.viewport), view.camera);
}

export function cameraTransform(camera: Camera): Affine {
    return [camera.z, 0, 0, camera.z, -camera.x * camera.z, -camera.y * camera.z];
}

export function cameraAtAnchor(world: Point, surface: Point, z: number): Camera {
    return { x: world.x - surface.x / z, y: world.y - surface.y / z, z };
}

export function fitWidthZ(viewport: Viewport, stack: Readonly<PageStack>, insets: ViewportInsets): number {
    return stack.width > 0 ? Math.max(0, viewport.width - insets.left - insets.right) / stack.width : 0;
}

export function pagedPosition(camera: Camera, viewport: Viewport, stack: Readonly<PageStack>, insets: ViewportInsets): PagedPosition | null {
    const fit = fitWidthZ(viewport, stack, insets);
    const page = pageAt(stack, camera.y);
    if (!fit || page < 0) return null;
    const rect = stack.rects[page];
    return {
        page,
        offset: rect.height > 0 ? clamp((camera.y - rect.y) / rect.height, 0, 1) : 0,
        zoom: camera.z / fit,
    };
}

export function cameraForPagedPosition(position: PagedPosition, viewport: Viewport, stack: Readonly<PageStack>,
    insets: ViewportInsets, limits: ZoomLimits, centerWorldX = stack.width / 2): Camera | null {
    validateLimits(limits);
    if (!Number.isFinite(position.page) || !Number.isFinite(position.offset) || !positive(position.zoom)) {
        throw new RangeError('Paged position must be finite with positive user zoom');
    }
    const fit = fitWidthZ(viewport, stack, insets);
    if (!fit || !stack.rects.length) return null;
    const rect = stack.rects[clamp(Math.floor(position.page), 0, stack.rects.length - 1)];
    const offset = clamp(position.offset, 0, 1);
    const z = fit * clamp(position.zoom, limits.min, limits.max);
    return {
        x: centerWorldX - (insets.left + (viewport.width - insets.left - insets.right) / 2) / z,
        y: rect.y + offset * rect.height - (offset === 0 ? insets.top / z : 0),
        z,
    };
}

export function freeConstraint(limits: ZoomLimits): CameraConstraint {
    validateLimits(limits);
    const { min, max } = limits;
    return {
        clampZoom: z => clamp(z, min, max),
        bounds: () => unbounded,
        resize: (camera, previous, next) => cameraAtAnchor(
            surfaceToWorld({ x: previous.width / 2, y: previous.height / 2 }, camera),
            { x: next.width / 2, y: next.height / 2 }, camera.z),
        allowsHorizontalPan: () => true,
    };
}

export function pagedConstraint(stack: Readonly<PageStack>, limits: ZoomLimits, insets: ViewportInsets): CameraConstraint {
    validateLimits(limits);
    if (Object.values(insets).some(value => !Number.isFinite(value) || value < 0)) {
        throw new RangeError('Viewport insets must be finite and nonnegative');
    }
    const pages: PageStack = { rects: stack.rects.map(rect => ({ ...rect })), width: stack.width, height: stack.height };
    const edges = { ...insets };
    const zoomLimits = { ...limits };
    return {
        clampZoom(z, viewport) {
            const fit = fitWidthZ(viewport, pages, edges);
            return fit > 0 ? fit * clamp(z / fit, zoomLimits.min, zoomLimits.max) : z;
        },
        bounds(camera, viewport) {
            if (!pages.rects.length || viewport.width === 0 || viewport.height === 0) {
                return { minX: camera.x, maxX: camera.x, minY: camera.y, maxY: camera.y };
            }
            const available = Math.max(0, viewport.width - edges.left - edges.right);
            const centeredX = -(edges.left + (available - pages.width * camera.z) / 2) / camera.z;
            const minY = -edges.top / camera.z;
            return {
                minX: pages.width * camera.z <= available ? centeredX : -edges.left / camera.z,
                maxX: pages.width * camera.z <= available ? centeredX : pages.width - (viewport.width - edges.right) / camera.z,
                minY,
                maxY: Math.max(minY, pages.height - (viewport.height - edges.bottom) / camera.z),
            };
        },
        resize(camera, previous, next) {
            const previousFit = fitWidthZ(previous, pages, edges);
            const nextFit = fitWidthZ(next, pages, edges);
            if (!previousFit || !nextFit) return camera;
            const z = nextFit * clamp(camera.z / previousFit, zoomLimits.min, zoomLimits.max);
            const center = surfaceToWorld({ x: (edges.left + previous.width - edges.right) / 2, y: 0 }, camera).x;
            const minY = -edges.top / camera.z;
            const pinnedTop = camera.y === minY || camera.y === snapOrigin(minY, camera.z * previous.dpr, minY, Infinity);
            return {
                x: center - (edges.left + (next.width - edges.left - edges.right) / 2) / z,
                y: pinnedTop ? -edges.top / z : camera.y,
                z,
            };
        },
        allowsHorizontalPan: (camera, viewport) => pages.width * camera.z > Math.max(0, viewport.width - edges.left - edges.right),
    };
}

function constrainCamera(camera: Camera, viewport: Viewport, constraint: CameraConstraint): Camera {
    const next = { ...camera, z: constraint.clampZoom(camera.z, viewport) };
    const bounds = constraint.bounds(next, viewport);
    return { x: clamp(next.x, bounds.minX, bounds.maxX), y: clamp(next.y, bounds.minY, bounds.maxY), z: next.z };
}

function snapOrigin(value: number, scale: number, min: number, max: number): number {
    const device = value * scale;
    let nearest = Math.round(device);
    if (device - Math.floor(device) === 0.5) {
        const lower = Math.floor(device);
        const upper = lower + 1;
        const lowerInside = lower / scale >= min && lower / scale <= max;
        const upperInside = upper / scale >= min && upper / scale <= max;
        if (lowerInside !== upperInside) nearest = lowerInside ? lower : upper;
    }
    return nearest / scale;
}

export function snapCamera(camera: Camera, viewport: Viewport, bounds: OriginBounds = unbounded): Camera {
    const scale = camera.z * viewport.dpr;
    return {
        x: snapOrigin(camera.x, scale, bounds.minX, bounds.maxX),
        y: snapOrigin(camera.y, scale, bounds.minY, bounds.maxY),
        z: camera.z,
    };
}

export interface PagePresentation {
    surface: Affine;
    device: Affine;
    restOffsetDevice: Point;
}

export function pagePresentation(page: Rect, view: ViewState): PagePresentation {
    const origin = worldToDevice(page, view);
    const offset = view.moving ? { x: 0, y: 0 } : { x: Math.round(origin.x) - origin.x, y: Math.round(origin.y) - origin.y };
    const z = view.camera.z;
    const dpr = view.viewport.dpr;
    const deviceX = view.moving ? origin.x : Math.round(origin.x);
    const deviceY = view.moving ? origin.y : Math.round(origin.y);
    return {
        surface: [z, 0, 0, z, deviceX / dpr, deviceY / dpr],
        device: [z * dpr, 0, 0, z * dpr, deviceX, deviceY],
        restOffsetDevice: offset,
    };
}

export function pageLocalToSurface(point: Point, presentation: PagePresentation): Point {
    return { x: point.x * presentation.surface[0] + presentation.surface[4], y: point.y * presentation.surface[3] + presentation.surface[5] };
}

export function surfaceToPageLocal(point: Point, presentation: PagePresentation): Point {
    return { x: (point.x - presentation.surface[4]) / presentation.surface[0], y: (point.y - presentation.surface[5]) / presentation.surface[3] };
}

export interface WheelSample {
    deltaX: number;
    deltaY: number;
    deltaMode: 'pixel' | 'line' | 'page';
    shift: boolean;
}

export function wheelDelta(sample: WheelSample, viewport: Viewport): Point {
    if (!Number.isFinite(sample.deltaX) || !Number.isFinite(sample.deltaY)) throw new RangeError('Wheel deltas must be finite');
    const unit = sample.deltaMode === 'line' ? 16 : sample.deltaMode === 'page' ? viewport.height : 1;
    // Chrome on macOS often shifts a wheel to deltaX already; adding deltaY would double the pan.
    return sample.shift
        ? { x: (sample.deltaX !== 0 ? sample.deltaX : sample.deltaY) * unit, y: 0 }
        : { x: sample.deltaX * unit, y: sample.deltaY * unit };
}

export class CameraController {
    private cameraValue: Readonly<Camera>;
    private viewportValue: Readonly<Viewport>;
    private snapDpr: number | null = null;
    private lastIdeal: Camera | null = null;
    private resizeReference: Readonly<Viewport>;
    private constraint: CameraConstraint;
    private epoch = 0;
    private moving = false;
    private frameId = -1;
    private frameState: ViewState | null = null;

    constructor(camera: Camera, viewport: Viewport, constraint: CameraConstraint) {
        validateViewport(viewport);
        validateCamera(camera, viewport);
        this.constraint = constraint;
        this.viewportValue = Object.freeze({ ...viewport });
        this.resizeReference = this.viewportValue;
        const constrained = constrainCamera(camera, viewport, constraint);
        validateCamera(constrained, viewport);
        this.cameraValue = Object.freeze(constrained);
    }

    get camera(): Readonly<Camera> { return this.cameraValue; }
    get viewport(): Readonly<Viewport> { return this.viewportValue; }

    setCamera(camera: Camera): void {
        validateCamera(camera, this.viewportValue);
        const next = constrainCamera(camera, this.viewportValue, this.constraint);
        validateCamera(next, this.viewportValue);
        this.publishCamera(next);
    }

    setConstraint(constraint: CameraConstraint): void {
        const next = constrainCamera(this.cameraValue, this.viewportValue, constraint);
        validateCamera(next, this.viewportValue);
        this.constraint = constraint;
        this.publishCamera(next);
    }

    setViewport(viewport: Viewport, anchor?: CameraAnchor, geometryChanged = false, snapDpr?: number): void {
        validateViewport(viewport);
        if (snapDpr !== undefined && Number.isFinite(snapDpr) && snapDpr > 0) this.snapDpr = snapDpr;
        const previous = this.viewportValue;
        if (previous.width === viewport.width && previous.height === viewport.height && previous.dpr === viewport.dpr) {
            if (geometryChanged) this.epoch++;
            return;
        }
        const reference = previous.width > 0 && previous.height > 0 ? previous : this.resizeReference;
        const visibleSize = viewport.width > 0 && viewport.height > 0;
        const resized = !visibleSize || (reference.width === viewport.width && reference.height === viewport.height)
            ? this.cameraValue : this.constraint.resize(this.cameraValue, reference, viewport);
        const next = constrainCamera(anchor ? cameraAtAnchor(anchor.world, anchor.surface, resized.z) : resized, viewport, this.constraint);
        validateCamera(next, viewport);
        this.viewportValue = Object.freeze({ ...viewport });
        if (visibleSize) this.resizeReference = this.viewportValue;
        this.epoch++;
        this.publishCamera(next);
    }

    setMoving(moving: boolean): void {
        if (this.moving === moving) return;
        this.moving = moving;
        this.epoch++;
    }

    panBy(delta: Point): void {
        this.setCamera({ x: this.cameraValue.x + delta.x / this.cameraValue.z, y: this.cameraValue.y + delta.y / this.cameraValue.z, z: this.cameraValue.z });
    }

    panWheel(sample: WheelSample): void {
        const delta = wheelDelta(sample, this.viewportValue);
        if (!this.constraint.allowsHorizontalPan(this.cameraValue, this.viewportValue)) delta.x = 0;
        this.panBy(delta);
    }

    clampZoom(z: number): number {
        if (!positive(z)) throw new RangeError('Camera zoom must be finite and positive');
        const clamped = this.constraint.clampZoom(z, this.viewportValue);
        if (!positive(clamped)) throw new RangeError('Camera constraint returned an invalid zoom');
        return clamped;
    }

    zoomTo(z: number, anchor: Point = { x: this.viewportValue.width / 2, y: this.viewportValue.height / 2 }): void {
        const clampedZ = this.clampZoom(z);
        this.setCamera(cameraAtAnchor(surfaceToWorld(anchor, this.cameraValue), anchor, clampedZ));
    }

    zoomWheel(deltaY: number, anchor: Point): void {
        if (!Number.isFinite(deltaY)) throw new RangeError('Pinch delta must be finite');
        this.zoomTo(this.cameraValue.z * Math.exp(-clamp(deltaY, -50, 50) * 0.01), anchor);
    }

    bringIntoView(rect: Rect, marginCss = 0): void {
        if (![rect.x, rect.y, rect.width, rect.height, marginCss].every(Number.isFinite) || rect.width < 0 || rect.height < 0 || marginCss < 0) {
            throw new RangeError('Reveal rectangle and margin must be finite and nonnegative in size');
        }
        const margin = Math.min(marginCss, this.viewportValue.width / 2, this.viewportValue.height / 2) / this.cameraValue.z;
        const width = this.viewportValue.width / this.cameraValue.z;
        const height = this.viewportValue.height / this.cameraValue.z;
        let { x, y } = this.cameraValue;
        if (rect.x < x + margin || rect.width > width - 2 * margin) x = rect.x - margin;
        else if (rect.x + rect.width > x + width - margin) x = rect.x + rect.width - width + margin;
        if (rect.y < y + margin || rect.height > height - 2 * margin) y = rect.y - margin;
        else if (rect.y + rect.height > y + height - margin) y = rect.y + rect.height - height + margin;
        this.setCamera({ x, y, z: this.cameraValue.z });
    }

    private snapViewport(): Readonly<Viewport> {
        return this.snapDpr === null || this.snapDpr === this.viewportValue.dpr ? this.viewportValue : { ...this.viewportValue, dpr: this.snapDpr };
    }

    beginFrame(frameId: number): ViewState {
        if (!Number.isSafeInteger(frameId) || frameId < 0 || frameId < this.frameId) throw new RangeError('Frame ids must be monotonic nonnegative integers');
        if (frameId === this.frameId && this.frameState) return this.frameState;
        const ideal = constrainCamera(this.cameraValue, this.viewportValue, this.constraint);
        this.publishCamera(ideal);
        const travelling = this.moving && this.lastIdeal !== null &&
            (ideal.x !== this.lastIdeal.x || ideal.y !== this.lastIdeal.y || ideal.z !== this.lastIdeal.z);
        this.lastIdeal = ideal;
        const next = travelling ? ideal : snapCamera(ideal, this.snapViewport(), this.constraint.bounds(ideal, this.viewportValue));
        validateCamera(next, this.viewportValue);
        // Rest snapping is presentation, not a new semantic input. Writing it back made a
        // fractional scroll alternate raw→snapped every frame (epoch +2), cancelling CPU bands
        // forever after quality reduction changed the device-pixel phase.
        this.frameId = frameId;
        this.frameState = Object.freeze({ camera: Object.freeze({ ...next }), viewport: this.viewportValue, epoch: this.epoch, moving: this.moving });
        return this.frameState;
    }

    private publishCamera(camera: Camera): void {
        if (camera.x !== this.cameraValue.x || camera.y !== this.cameraValue.y || camera.z !== this.cameraValue.z) {
            this.cameraValue = Object.freeze({ ...camera });
            this.epoch++;
        }
    }
}
