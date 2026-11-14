import { useEffect, useMemo, useState } from 'react';
import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import { surfaceToWorld } from '../../platform/render/camera';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { openContextMenu } from '../../utils/contextMenu';
import { createNativeClipboardCommands } from '../../whiteboard/host/clipboardCommands';
import { BoardPreferenceState, readBoardViewFlags } from '../../whiteboard/chrome/preferences';
import type { Op } from '../../whiteboard/change/ops';
import { createBoardMediaIngestor } from '../../whiteboard/host/mediaIngest';
import { createNativeMediaPorts } from '../../whiteboard/host/mediaPorts';
import { prepareNativeExport } from '../../whiteboard/host/nativeExport';
import { getPdfInkSourceState } from '../../whiteboard/host/preparePdfInkSession';
import type { MediaEntry } from '../../whiteboard/model/media';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { selectAllAtFocus } from '../../whiteboard/selection';
import type { ViewerViewHandle } from './ViewerHost';
import type { NativeViewLease } from './nativeViewLease';
import { createNativeClipboardController } from './nativeClipboardController';

interface ViewBinding {
    readonly controller: ReturnType<typeof createNativeClipboardController>;
    readonly surface: HTMLElement;
    readonly theme: () => 'light' | 'dark';
    readonly notice: (message: string) => void;
}
export interface NativeClipboardBinding {
    readonly controller: ReturnType<typeof createNativeClipboardController>;
    readonly commands: ReturnType<typeof createNativeClipboardCommands>;
    openMenu(event: MouseEvent): void;
    focus(): void;
    detach(): void;
}
export interface NativeClipboardService {
    readonly preferences: BoardPreferenceState;
    attach(surface: HTMLElement, lease: NativeViewLease, theme: () => 'light' | 'dark', notice: (message: string) => void,
        inputHandled?: boolean): NativeClipboardBinding;
}
const services = new WeakMap<BoardRuntime, NativeClipboardService>();
let serial = 0;

export function documentClipboard(runtime: BoardRuntime, host: NativeCanvasHost, identity: NativeCanvasIdentity): NativeClipboardService {
    const existing = services.get(runtime);
    if (existing) return existing;
    const token = Object.freeze({ documentId: identity.documentId, session: identity.session,
        vaultEpoch: identity.vaultActivation, bytesGeneration: identity.bytesGeneration });
    const current = () => host.isCurrent(identity) && runtime.session.owner.documentId === identity.documentId
        && runtime.session.owner.session === identity.session;
    if (!current()) throw new Error('Clipboard document is no longer current');
    if (identity.kind === 'pdfInk' && !getPdfInkSourceState(identity.documentId)) throw new Error('The PDF ink source is unavailable');
    const now = performance.now();
    let live = 0, disposed = false, active: ViewBinding | undefined;
    const controllers = new Set<ReturnType<typeof createNativeClipboardController>>(), bindings = new Set<ViewBinding>();
    const cache = getPlatformRuntime().governor.register({ id: `board-clipboard:${identity.documentId}:${++serial}`,
        owner: token, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null, lastVisibleAt: now, lastUsedAt: now,
        memory: () => ({ live, retiring: 0 }), evict: () => {} });
    const memory: MemoryAllocator = {
        reserve(bytes) { const value = cache.reserve(bytes); if (value) live += value.bytes; return value; },
        release(value) { cache.release(value); live -= value.bytes; },
    };
    const report = (message: string) => { const target = active ?? bindings.values().next().value; target?.notice(message); };
    const fail = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) report(error instanceof Error ? error.message : String(error)); };
    const preferenceLifetime = new AbortController();
    const preferences = new BoardPreferenceState(readBoardViewFlags(runtime.session.doc.view), flags => {
        if (!current() || runtime.session.isReadOnly) throw new Error(runtime.session.readOnlyReason ?? 'Board is read-only');
        runtime.tools.setLocked(flags.toolLock);
        void runtime.session.enqueueAfterGesture(preferenceLifetime.signal, () => {
            if (!current() || runtime.session.isReadOnly) return;
            const view = runtime.session.doc.view, ops: Op[] = [];
            for (const key of ['grid', 'focusMode', 'transparent', 'debugMode'] as const) {
                if (view[key] !== flags[key]) ops.push({ t: 'board', key: `view.${key}`, value: flags[key] });
            }
            if (ops.length) runtime.session.apply({ origin: 'host', label: 'Board view preferences', ops }).release();
        }).catch(fail);
    });
    const stopPreferences = runtime.session.subscribe(() => preferences.reconcileView(readBoardViewFlags(runtime.session.doc.view)));
    const finishGesture = () => { if (runtime.session.isGestureActive) throw new Error('Finish the current gesture before pasting.'); };
    const ports = createNativeMediaPorts(host, identity);
    const pdfSource = () => {
        const source = getPdfInkSourceState(identity.documentId);
        if (!source || !current()) throw new Error('The PDF ink source is unavailable');
        return source;
    };
    const readMedia = async (entry: MediaEntry, signal: AbortSignal) => identity.kind === 'pdfInk'
        ? pdfSource().readMedia(entry.id, signal) : (await ports.read(entry, signal))?.blob ?? null;
    const storeMedia = (entry: MediaEntry, blob: Blob, signal: AbortSignal) => {
        if (identity.kind === 'pdfInk') return Promise.reject(new Error('PDF media cannot be changed in this view'));
        return ports.restore(entry, blob, signal);
    };
    const ingestor = createBoardMediaIngestor({ runtime, memory, current, finishGesture, storeMedia,
        noticeRefused: files => report(files.map(file => `${file.name}: ${file.reason}`).join('; ')) });
    let commands: ReturnType<typeof createNativeClipboardCommands>;
    try {
        commands = createNativeClipboardCommands({ runtime, token, memory, cache: host.clipboard, current,
            prepareExport: (route, signal) => prepareNativeExport({ runtime, route, signal,
                boardName: host.identity(identity.documentId)?.name ?? identity.name, theme: active?.theme() ?? 'light',
                transparent: runtime.session.doc.view.transparent, current, notice: report, onError: fail,
                ...(identity.kind === 'pdfInk' ? { retainPdfSource: () => {
                    const source = pdfSource();
                    if (source.getSnapshot().status !== 'ready') throw new Error('The PDF source is updating');
                    return source.retainSource();
                } } : {}) }),
            duplicate: snapshot => {
                if (!active) return Promise.reject(new Error('The board view is unavailable'));
                return active.controller.duplicate(snapshot);
            }, notice: report, onError: fail,
            copyPng: capture => {
                const custom = capture.then(blob => new Blob([blob], { type: 'image/x-board+png' }));
                void custom.catch(() => {});
                return navigator.clipboard.write([new ClipboardItem({ 'image/png': capture, 'web image/x-board+png': custom })]);
            },
            copySvg: capture => {
                const text = capture.then(blob => new Blob([blob], { type: 'text/plain' }));
                void text.catch(() => {});
                return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
            },
            download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a');
                link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); },
        });
    } catch (error) { stopPreferences(); preferenceLifetime.abort(); ingestor.dispose(); cache.close(); throw error; }
    const service: NativeClipboardService = {
        preferences,
        attach(surface, lease, theme, notice, inputHandled = false) {
            if (disposed || !current() || lease.runtime !== runtime) throw new Error('Clipboard document is no longer current');
            let pointer: { x: number; y: number } | null = null;
            const surfacePoint = (x: number, y: number) => {
                const bounds = surface.getBoundingClientRect(), viewport = lease.camera.viewport;
                if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Board surface is unavailable');
                return { x: (x - bounds.left) * viewport.width / bounds.width, y: (y - bounds.top) * viewport.height / bounds.height };
            };
            const editingText = () => {
                const focused = document.activeElement;
                return focused instanceof HTMLElement && focused !== surface && surface.contains(focused)
                    && (focused.isContentEditable || focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement);
            };
            const controller = createNativeClipboardController({ runtime, host, identity, memory, ingestor, camera: lease.camera,
                pasteAtCursor: () => preferences.getSnapshot().session.pasteAtCursor, pointer: () => pointer, surfacePoint, editingText, finishGesture,
                matchClipboard: commands.matchClipboard, readMedia, storeMedia, notice: report, onError: fail });
            controllers.add(controller);
            const binding: ViewBinding = { controller, surface, theme, notice }; bindings.add(binding); active = binding;
            const focus = () => { active = binding; };
            const move = (event: PointerEvent) => { focus(); try { pointer = surfaceToWorld(surfacePoint(event.clientX, event.clientY), lease.camera.camera); } catch { pointer = null; } };
            const copy = (event: ClipboardEvent) => { if (!editingText()) { focus(); commands.copyEvent(event); } };
            const cut = (event: ClipboardEvent) => { if (!editingText()) { focus(); commands.copyEvent(event, true); } };
            const paste = (event: ClipboardEvent) => { if (!runtime.session.isReadOnly) { focus(); controller.pasteEvent(event); } };
            const keydown = (event: KeyboardEvent) => {
                if (editingText()) return;
                focus();
                if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
                    const state = runtime.selection.getSnapshot();
                    runtime.selection.replace(selectAllAtFocus(runtime.session.doc, state.sheet, state.focus));
                    event.preventDefault(); event.stopPropagation(); return;
                }
                if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
                    event.preventDefault(); event.stopPropagation(); void commands.copyAsPng(); return;
                }
                if (!runtime.session.isReadOnly) {
                    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
                        event.preventDefault(); event.stopPropagation(); void commands.duplicate(); return;
                    }
                    controller.keydown(event);
                }
            };
            const dragover = (event: DragEvent) => { if (!runtime.session.isReadOnly) controller.dragover(event); };
            const drop = (event: DragEvent) => { if (!runtime.session.isReadOnly) { focus(); controller.drop(event); } };
            const menu = (event: MouseEvent) => {
                event.preventDefault(); event.stopPropagation(); focus();
                const selected = runtime.selection.getSnapshot().selected.length > 0, readonly = runtime.session.isReadOnly;
                const disabled = !selected, why = 'Select content to copy.';
                openContextMenu({ x: event.clientX, y: event.clientY, label: 'Canvas', opener: surface, entries: [
                    { kind: 'command', id: 'copy', label: 'Copy', disabled, ...(disabled ? { reason: why } : {}), run: commands.copy },
                    { kind: 'command', id: 'copy-png', label: 'Copy as PNG', run: commands.copyAsPng },
                    { kind: 'command', id: 'copy-svg', label: 'Copy as SVG', run: commands.copyAsSvg },
                    { kind: 'command', id: 'copy-json', label: 'Copy as JSON', run: commands.copyAsJson },
                    { kind: 'command', id: 'export-png', label: 'Export PNG', run: () => commands.exportPng('context') },
                    { kind: 'command', id: 'export-svg', label: 'Export SVG', run: () => commands.exportSvg('context') },
                    { kind: 'command', id: 'paste', label: 'Paste', disabled: readonly, ...(readonly ? { reason: 'This canvas is read-only.' } : {}), run: () => controller.paste() },
                ] });
            };
            surface.addEventListener('focus', focus); surface.addEventListener('pointermove', move);
            surface.addEventListener('copy', copy); surface.addEventListener('cut', cut);
            if (!inputHandled) {
                surface.addEventListener('paste', paste); surface.addEventListener('keydown', keydown);
                surface.addEventListener('dragover', dragover); surface.addEventListener('drop', drop); surface.addEventListener('contextmenu', menu);
            }
            let detached = false;
            return { controller, commands, openMenu: menu, focus, detach() {
                if (detached) return; detached = true;
                bindings.delete(binding); if (active === binding) active = bindings.values().next().value;
                controller.retire(() => controllers.delete(controller));
                surface.removeEventListener('focus', focus); surface.removeEventListener('pointermove', move);
                surface.removeEventListener('copy', copy); surface.removeEventListener('cut', cut);
                if (!inputHandled) {
                    surface.removeEventListener('paste', paste); surface.removeEventListener('keydown', keydown);
                    surface.removeEventListener('dragover', dragover); surface.removeEventListener('drop', drop); surface.removeEventListener('contextmenu', menu);
                }
            } };
        },
    };
    try {
        runtime.registerOwned(() => {
            if (disposed) return; disposed = true; services.delete(runtime); active = undefined; bindings.clear();
            preferenceLifetime.abort(); stopPreferences();
            try { commands.dispose(); } finally {
                try { for (const controller of controllers) controller.dispose(); } finally {
                    controllers.clear(); try { ingestor.dispose(); } finally { cache.close(); }
                }
            }
        });
        services.set(runtime, service);
        return service;
    } catch (error) { preferenceLifetime.abort(); stopPreferences(); commands.dispose(); ingestor.dispose(); cache.close(); throw error; }
}

/** Only event listeners and camera belong to a pane; the command service belongs to the document. */
export function useNativeClipboard(lease: NativeViewLease, host: NativeCanvasHost, identity: NativeCanvasIdentity,
    theme: () => 'light' | 'dark', notice: (message: string) => void): ViewerViewHandle {
    const [state, setState] = useState<{ runtime: BoardRuntime; service: NativeClipboardService } | null>(null);
    const service = state?.runtime === lease.runtime ? state.service : null;
    useEffect(() => {
        try { setState({ runtime: lease.runtime, service: documentClipboard(lease.runtime, host, identity) }); }
        catch (error) { notice(error instanceof Error ? error.message : String(error)); }
    }, [lease.runtime, host, identity, notice]);
    return useMemo(() => ({ ...lease.view, attachInput(surface: HTMLElement, overlay: HTMLElement) {
        const detach = lease.view.attachInput(surface, overlay);
        if (!service) return detach;
        try { const binding = service.attach(surface, lease, theme, notice); return () => { binding.detach(); detach(); }; }
        catch (error) { detach(); throw error; }
    } }), [lease, service, theme, notice]);
}
