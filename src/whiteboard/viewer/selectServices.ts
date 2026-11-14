import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';
import type { Op } from '../change/ops';
import { planDelete } from '../commands/delete';
import { TranslationPlan } from '../geom/translation';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { EraserContext } from '../input/basicTools';
import type { SweptSelectionCursor, SweepPoint, SweepQueueServices } from '../input/sweepQueue';
import type { NodeId } from '../model/ids';
import type { createBoardRenderServices } from '../render/services';
import { TransformGesture } from '../tools/transform';
import { translationDriver } from '../tools/transformDrivers';
import type { SelectRegion, SelectToolContext } from '../tools/select';
import type { createBoardPointQuery } from './pointQuery';
import type { createBoardRegionQuery } from './regionQuery';

// Provenance: SelectGesture, swept selection, geometry preparation, transaction
// and shared frame contracts; independent host composition, no third-party source.
export interface BoardSelectServicesOptions {
    readonly runtime: BoardRuntime;
    readonly render: Pick<ReturnType<typeof createBoardRenderServices>, 'prepareChangeGeometry' | 'changeGeometry'>;
    readonly camera: () => ViewState;
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hit'>;
    readonly region: Pick<ReturnType<typeof createBoardRegionQuery>, 'region'>;
    readonly preview: { showOps(ops: readonly Op[]): void; clear(): void };
    readonly overlay: HTMLElement;
    readonly token: RenderToken;
    current(token: RenderToken): boolean;
    readonly inputFrames: { schedule(callback: () => void): () => void };
    onError(error: unknown): void;
}
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
export function createBoardSelectServices(options: BoardSelectServicesOptions) {
    const { runtime, render } = options, session = runtime.session, doc = session.doc;
    const token = Object.freeze({ ...options.token });
    const pending = new Set<() => void>(), controllers = new Set<AbortController>();
    let disposed = false, regionPreview: SelectRegion | null = null, previewIds = new Set<NodeId>();
    let svg: SVGSVGElement | null = null, shape: SVGElement | null = null, scheduled: (() => void) | null = null;
    let warmedRevision = -1, warmed = new Set<NodeId>();
    const current = () => !disposed && options.current(token);
    const mutable = () => current() && !session.isReadOnly;
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Preserve the original operation failure. */ } };
    const requestFrame = () => {
        if (disposed || scheduled) return;
        scheduled = options.inputFrames.schedule(() => { scheduled = null; });
    };
    const registerPending = (cancel: () => void) => {
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
        pending.add(cancel); return () => { pending.delete(cancel); };
    };
    const cancelPending = () => {
        const work = [...pending], had = work.length > 0 || controllers.size > 0;
        pending.clear(); for (const cancel of work) { try { cancel(); } catch (error) { report(error); } }
        for (const controller of controllers) controller.abort(); controllers.clear();
        return had;
    };
    const toSurface = (point: Vec2) => worldToSurface(point, options.camera().camera);
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
    };
    const doRegion = async (points: readonly Vec2[], radiusCss: number, signal: AbortSignal) => {
        check(signal); const view = options.camera(), css = points.map(point => worldToSurface(point, view.camera));
        return options.region.region({ kind: 'swept', points: css, radiusCss, localToSurface: IDENTITY }, signal);
    };
    const beginSweep = (from: SweepPoint, to: SweepPoint, topOnly: boolean, radius: number): SweptSelectionCursor => {
        const controller = new AbortController(), revision = doc.rev;
        controllers.add(controller);
        let result: readonly NodeId[] | null = null, failure: unknown, stopped = false;
        const waiters = new Set<() => void>();
        const wake = () => { for (const callback of [...waiters]) callback(); waiters.clear(); };
        void (async () => {
            const ids = await doRegion([from, to], radius, controller.signal);
            check(controller.signal);
            const selected = topOnly && ids.length ? [ids[ids.length - 1]] : ids;
            await render.prepareChangeGeometry(selected, controller.signal);
            check(controller.signal);
            if (doc.rev !== revision) throw new DOMException('Board changed during sweep', 'AbortError');
            result = selected;
        })().catch(error => { if (!stopped) failure = error; }).finally(() => { controllers.delete(controller); wake(); });
        return {
            step() {
                if (stopped) return { status: 'cancelled', ids: [] };
                if (doc.rev !== revision) return { status: 'stale', ids: [] };
                if (failure) throw failure;
                if (!result) return { status: 'pending', ids: [] };
                return { status: 'complete', ids: result };
            },
            wait(callback) {
                if (stopped || result || failure || doc.rev !== revision) { callback(); return () => {}; }
                waiters.add(callback); return () => { waiters.delete(callback); };
            },
            cancel() { if (stopped) return; stopped = true; controller.abort(); controllers.delete(controller); waiters.clear(); },
        };
    };
    const sweep = (eraser: boolean): SweepQueueServices => ({
        beginSweep: (from, to, topOnly) => beginSweep(from, to, topOnly, eraser ? 8 : 6),
        sceneRevision: () => doc.rev, now: () => performance.now(), schedule: callback => options.inputFrames.schedule(callback),
        preview(ids) {
            previewIds = new Set(ids);
            if (eraser) options.preview.showOps([...ids].map(id => ({ t: 'set', id, key: 'opacity', value: 0.5 } as const)));
            requestFrame();
        },
    });
    const select: SelectToolContext = {
        selection: runtime.selection, dragThresholdCss: 4, scribble: sweep(false),
        hold: () => session.beginGesture(), registerPending, toSurface, isCurrent: mutable,
        async hit(sample, signal) {
            check(signal); const revision = doc.rev;
            const point = toSurface(sample), input = sample.source === 'keyboard' ? 'mouse' : sample.source;
            const id = await options.point.hit(point, input, signal); check(signal);
            const ids = new Set(runtime.selection.getSnapshot().selected); if (id) ids.add(id);
            await render.prepareChangeGeometry(ids, signal); check(signal);
            if (doc.rev !== revision) throw new DOMException('Board changed during selection preflight', 'AbortError');
            warmedRevision = revision; warmed = ids;
            return id;
        },
        async region(region, signal) {
            check(signal); const camera = options.camera().camera;
            if (region.kind === 'scribble') return doRegion(region.points, 6, signal);
            const a = worldToSurface(region.start, camera), b = worldToSurface(region.end, camera);
            return options.region.region({ kind: 'polygon', containment: region.containment, localToSurface: IDENTITY,
                points: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] }, signal);
        },
        preview(value) { regionPreview = value; if (!value) previewIds.clear(); requestFrame(); },
        beginTransform(sample, hit, modifiers) {
            check(); const ids = runtime.selection.getSnapshot().selected, revision = doc.rev;
            if (warmedRevision !== revision || !warmed.has(hit) || ids.some(id => !warmed.has(id))) throw new Error('Selection geometry is not preflighted');
            const plan = new TranslationPlan(doc, ids, render.changeGeometry);
            return new TransformGesture(sample, modifiers, translationDriver(plan, sample), {
                hold: () => session.beginGesture(), registerPending,
                isCurrent: () => mutable() && doc.rev === revision,
                showPreview: ops => options.preview.showOps(ops), clearPreview: () => options.preview.clear(),
                apply(transaction) { check(); if (doc.rev !== revision) throw new DOMException('Transform became stale', 'AbortError'); const applied = session.apply(transaction); applied.release(); },
                error: report,
            });
        },
        onError: report,
    };
    const eraserSweep = sweep(true);
    const eraser: EraserContext = {
        ...eraserSweep, hold: () => session.beginGesture(), registerPending,
        commit(ids) {
            check(); if (!ids.size) return;
            const builder = session.begin('tool', 'Erase');
            try { planDelete(doc, builder, runtime.selection.getSnapshot().sheet, [...ids], render.changeGeometry); const applied = builder.commit(); applied.release(); }
            catch (error) { builder.abort(); throw error; }
        },
        clearPreview() { previewIds.clear(); options.preview.clear(); requestFrame(); }, error: report,
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        if (!regionPreview) { svg?.remove(); svg = null; shape = null; return; }
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('aria-hidden', 'true'); svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
            options.overlay.append(svg);
        }
        const kind = regionPreview.kind === 'marquee' ? 'rect' : 'polyline';
        if (!shape || shape.localName !== kind) { shape?.remove(); shape = document.createElementNS('http://www.w3.org/2000/svg', kind); svg.append(shape); }
        shape.setAttribute('stroke', previewIds.size ? '#75b7ff' : '#6a9fff'); shape.setAttribute('stroke-width', '1.5');
        if (regionPreview.kind === 'marquee') {
            const a = worldToSurface(regionPreview.start, frame.view.camera), b = worldToSurface(regionPreview.end, frame.view.camera);
            shape.setAttribute('x', String(Math.min(a.x, b.x))); shape.setAttribute('y', String(Math.min(a.y, b.y)));
            shape.setAttribute('width', String(Math.abs(a.x - b.x))); shape.setAttribute('height', String(Math.abs(a.y - b.y)));
            shape.setAttribute('fill', 'rgba(106,159,255,0.12)'); shape.setAttribute('stroke-dasharray', '4 3');
        } else {
            const points = regionPreview.points.map(point => worldToSurface(point, frame.view.camera));
            shape.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
            shape.setAttribute('fill', 'none'); shape.removeAttribute('stroke-dasharray');
        }
    };
    return { select, eraser, writeOverlays, cancelPending,
        dispose() { if (disposed) return; cancelPending(); disposed = true; scheduled?.(); scheduled = null; options.preview.clear(); svg?.remove(); svg = null; shape = null; },
    };
}
