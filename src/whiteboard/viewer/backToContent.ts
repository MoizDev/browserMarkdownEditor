import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { BoardRuntime } from '../host/runtime';

export interface BackToContentOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly surface: HTMLElement;
    current(): boolean;
    activate(): void;
    error(error: unknown): void;
    cooperate?(): Promise<void>;
}

/** View chrome only: a bounded spatial query decides whether the sheet's ink
 * intersects the presented viewport. The button never edits or selects nodes. */
export function createBackToContent(options: BackToContentOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let disposed = false, generation = 0, key = '', controller: AbortController | undefined, button: HTMLButtonElement | undefined;
    const current = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const hide = () => { if (button) button.hidden = true; };
    const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (current()) options.activate(); };
    const pointer = (event: PointerEvent) => { event.stopPropagation(); };
    const contextMenu = (event: MouseEvent) => {
        event.preventDefault(); event.stopPropagation();
        if (!current()) return;
        // The board surface owns the menu; the floating button must not expose a native one.
        options.surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window,
            clientX: event.clientX, clientY: event.clientY, button: 2, buttons: event.buttons,
            altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }));
    };
    const focus = () => { if (button) { button.style.outline = '2px solid #75b7ff'; button.style.outlineOffset = '2px'; } };
    const blur = () => { if (button) { button.style.outline = ''; button.style.outlineOffset = ''; } };
    const show = () => {
        if (!button) {
            button = document.createElement('button'); button.type = 'button'; button.textContent = 'Back to content';
            button.setAttribute('aria-label', 'Back to content');
            button.style.cssText = 'position:absolute;right:16px;bottom:16px;pointer-events:auto;z-index:5;padding:7px 10px;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-primary);color:var(--text-normal);';
            button.addEventListener('pointerdown', pointer); button.addEventListener('click', click);
            button.addEventListener('contextmenu', contextMenu); button.addEventListener('focus', focus); button.addEventListener('blur', blur);
            options.overlay.append(button);
        }
        button.hidden = false;
    };
    const update = (frame: ScheduledFrame) => {
        if (!current() || doc.kind !== 'whiteboard') { controller?.abort(); controller = undefined; key = ''; hide(); return; }
        const view = frame.view, camera = view.camera, viewport = view.viewport, state = runtime.selection.getSnapshot();
        const next = [doc.rev, state.sheet, camera.x, camera.y, camera.z, viewport.width, viewport.height].join(':');
        if (view.moving) { controller?.abort(); controller = undefined; key = ''; hide(); return; }
        if (next === key) return;
        key = next; controller?.abort(); hide();
        if (!(viewport.width > 0 && viewport.height > 0 && camera.z > 0) || !(doc.bySheet.get(state.sheet)?.size)) return;
        const turn = ++generation, request = new AbortController(); controller = request;
        const revision = doc.rev, sheet = state.sheet, rect = [camera.x, camera.y,
            camera.x + viewport.width / camera.z, camera.y + viewport.height / camera.z] as const;
        const active = () => current() && controller === request && !request.signal.aborted && generation === turn && doc.rev === revision
            && runtime.selection.getSnapshot().sheet === sheet && key === next;
        void (async () => {
            const scene = runtime.scene ?? await runtime.ready;
            while (!scene.ready) { if (!active()) return; scene.step(64, performance.now() + 3); await cooperate(); }
            if (!active() || scene.revision !== revision) return;
            const cursor = scene.spatialCursor({ sheetId: sheet, purpose: 'ink', includeLocked: true,
                request: { kind: 'box', box: rect } });
            let found = false;
            try {
                for (;;) {
                    if (!active()) return;
                    const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                        if (!scene.resolveSpatial(ref)) throw new DOMException('Back-to-content query expired', 'AbortError');
                        found = true;
                    });
                    if (found || status === 'complete') break;
                    if (status !== 'pending') throw new DOMException('Back-to-content query expired', 'AbortError');
                    await cooperate();
                }
            } finally { cursor.cancel(); }
            if (active() && !found) show();
        })().catch(error => { if (active()) options.error(error); }).finally(() => { if (controller === request) controller = undefined; });
    };
    return { update, hide() { generation++; controller?.abort(); controller = undefined; key = ''; hide(); }, dispose() {
        if (disposed) return; disposed = true; generation++; controller?.abort(); controller = undefined;
        if (button) {
            button.removeEventListener('pointerdown', pointer); button.removeEventListener('click', click);
            button.removeEventListener('contextmenu', contextMenu); button.removeEventListener('focus', focus); button.removeEventListener('blur', blur);
            button.remove(); button = undefined;
        }
    } };
}
