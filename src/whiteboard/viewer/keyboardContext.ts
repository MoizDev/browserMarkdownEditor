import { worldToSurface, type CameraController, type Point } from '../../platform/render/camera';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { SelectionSnapshot } from '../selection';
import { yieldToHost } from '../../platform/yieldToHost';

export interface KeyboardContextRequest {
    readonly client: Readonly<Point>;
    readonly world: Readonly<Point>;
    readonly selection: SelectionSnapshot;
    readonly opener: HTMLElement;
}
export interface KeyboardContextOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly surface: HTMLElement;
    current(): boolean;
    open(request: KeyboardContextRequest): void;
    error(error: unknown): void;
    cooperate?(): Promise<void>;
}

export function createKeyboardContext(options: KeyboardContextOptions) {
    const { runtime, camera, surface } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? yieldToHost;
    let disposed = false, generation = 0, pending: AbortController | undefined;
    const current = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const cancel = () => { generation++; pending?.abort(); pending = undefined; };
    const unsubscribe = runtime.selection.subscribe(cancel);
    const activity = () => { if (pending) cancel(); };
    surface.addEventListener('pointerdown', activity, true);
    surface.addEventListener('keydown', activity, true);
    surface.addEventListener('wheel', activity, true);
    const openAt = (world: Point, selection: SelectionSnapshot) => {
        if (!current() || runtime.selection.getSnapshot() !== selection || ![world.x, world.y].every(Number.isFinite)) return;
        const viewport = camera.viewport, rect = surface.getBoundingClientRect();
        if (!(viewport.width > 0 && viewport.height > 0 && rect.width > 0 && rect.height > 0)) return;
        const raw = worldToSurface(world, camera.camera);
        const point = { x: Math.max(0, Math.min(viewport.width, raw.x)), y: Math.max(0, Math.min(viewport.height, raw.y)) };
        const client = { x: rect.left + point.x * rect.width / viewport.width, y: rect.top + point.y * rect.height / viewport.height };
        if (![client.x, client.y].every(Number.isFinite)) return;
        options.open({ client, world: { ...world }, selection, opener: surface });
    };
    const request = (_surface: Point, world: Point): boolean => {
        if (!current() || ![world.x, world.y].every(Number.isFinite)) return false;
        cancel(); const selection = runtime.selection.getSnapshot(), id = selection.active;
        if (!id) { openAt(world, selection); return true; }
        const controller = new AbortController(), turn = generation, revision = doc.rev; pending = controller;
        const active = () => current() && pending === controller && !controller.signal.aborted && turn === generation
            && doc.rev === revision && runtime.selection.getSnapshot() === selection;
        void (async () => {
            const scope = await acquireBoardGeometryScope(runtime, [id], { signal: controller.signal, current: active, cooperate });
            try {
                if (!active()) return;
                const bounds = scope.logicalBounds(id);
                const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
                if (active()) openAt(centre, selection);
            } finally { scope.release(); }
        })().catch(error => { if (active()) options.error(error); }).finally(() => { if (pending === controller) pending = undefined; });
        return true;
    };
    return { request, cancel, dispose() {
        if (disposed) return;
        disposed = true; cancel(); unsubscribe();
        surface.removeEventListener('pointerdown', activity, true);
        surface.removeEventListener('keydown', activity, true);
        surface.removeEventListener('wheel', activity, true);
    } };
}
