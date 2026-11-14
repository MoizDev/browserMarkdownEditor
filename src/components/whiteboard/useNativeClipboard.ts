import { useEffect, useMemo, useState } from 'react';
import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import { surfaceToWorld } from '../../platform/render/camera';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';
import { createNativeClipboardCommands } from '../../whiteboard/host/clipboardCommands';
import { BoardPreferenceState, readBoardViewFlags } from '../../whiteboard/chrome/preferences';
import type { Op } from '../../whiteboard/change/ops';
import { createBoardMediaIngestor } from '../../whiteboard/host/mediaIngest';
import { createNativeMediaPorts } from '../../whiteboard/host/mediaPorts';
import { createMediaActions, type MediaActions, type MediaSelection } from '../../whiteboard/host/mediaActions';
import type { PictureCropPreset } from '../../whiteboard/media/crop';
import { prepareNativeExport } from '../../whiteboard/host/nativeExport';
import { getPdfInkSourceState } from '../../whiteboard/host/preparePdfInkSession';
import { createPdfEmbeddedMediaStorage } from '../../whiteboard/host/pdfEmbeddedMedia';
import { issueMediaStorageReceipt } from '../../whiteboard/media/storage';
import type { StoreMedia } from '../../whiteboard/media/storage.types';
import type { MediaEntry } from '../../whiteboard/model/media';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { selectAllAtFocus } from '../../whiteboard/selection';
import type { ViewerViewHandle } from './ViewerHost';
import { downloadBoardExport } from './exportDelivery';
import type { NativeViewLease } from './nativeViewLease';
import { createNativeClipboardController } from './nativeClipboardController';
import { createBoardExportSnapshot } from '../../whiteboard/export/boardSnapshot';
import type { BoardPrintSource } from '../../whiteboard/export/print';
import { pinPagedPrintSource } from '../../whiteboard/export/pagedPrintSnapshot';
import { boardPageStack } from '../../whiteboard/model/pages';
import { printBoard } from './printBoard';

export interface FocusedBoardPrintOptions {
    readonly runtime: BoardRuntime;
    readonly kind: NativeCanvasIdentity['kind'];
    readonly boardName: string;
    readonly transparent: boolean;
    readMedia(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    /** True only while this board is still the same live document it was when printing started. */
    valid(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
}

/**
 * A PDF annotation page prints through its own paged pin: its PDF backdrop has no canonical print route yet, so this
 * path stays until the PDF print route exists. Every other board prints through the canonical export job.
 */
function pinPdfInkBoard(options: FocusedBoardPrintOptions): BoardPrintSource {
    const { runtime, readMedia, onError } = options;
    const media = async (entry: Readonly<MediaEntry>, signal: AbortSignal): Promise<Blob> => {
        const blob = await readMedia(entry as MediaEntry, signal);
        if (!blob) throw new Error('A picture on this board is unavailable for printing.');
        return blob;
    };
    const stack = boardPageStack(runtime.session.doc.host);
    if (!stack) throw new Error('Print pages are unavailable for this board.');
    const pin = createBoardExportSnapshot({ runtime, request: { sheetId: runtime.selection.getSnapshot().sheet, theme: 'light' },
        readMedia: media, onError });
    return pinPagedPrintSource(pin, stack.rects);
}

/** Mod-P on the focused native board: one canonical export job's print source, printed through the app's print helper. */
async function printFocusedBoard(options: FocusedBoardPrintOptions, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const source = options.kind === 'pdfInk' ? pinPdfInkBoard(options)
        : (await prepareNativeExport({ runtime: options.runtime, route: 'print', signal, boardName: options.boardName, theme: 'light',
            transparent: options.transparent, current: options.valid, notice: options.notice, onError: options.onError,
            readMedia: options.readMedia })).print;
    try {
        const pdf = await source.pdf(signal);
        await printBoard({ pdf, valid: options.valid, signal,
            renderFallback: async (limit, pageSignal) => {
                const count = Math.min(limit, source.pageCount), pages: Blob[] = [];
                for (let page = 0; page < count; page++) pages.push(await source.pngPage(page, pageSignal));
                return { pages, total: source.pageCount };
            },
            noticeTruncated: (printed, total) => options.notice(`Printing ${printed} of ${total} pages; export to PDF to print all`),
            onError: options.onError });
    } finally { source.release(); }
}

const CROP_ROWS: readonly { readonly preset: PictureCropPreset; readonly label: string }[] = [
    { preset: 'original', label: 'Original' }, { preset: 'square', label: 'Square' }, { preset: 'circle', label: 'Circle' },
    { preset: 'landscape', label: 'Landscape 4:3' }, { preset: 'portrait', label: 'Portrait 3:4' }, { preset: 'wide', label: 'Wide 16:9' },
];

/** The App's own picker for a replacement: one image, chosen from the right-click that asked for it. */
function chooseReplacementImage(): Promise<File | null> {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
        const finish = (file: File | null) => { input.onchange = null; input.oncancel = null; input.remove(); resolve(file); };
        input.onchange = () => finish(input.files?.[0] ?? null);
        input.oncancel = () => finish(null);
        document.body.append(input);
        input.click();
    });
}

/** Rows for the one picture or card the menu was raised over. A blocked row stays on screen and says why. */
function mediaRows(selection: MediaSelection, actions: MediaActions, fail: (error: unknown) => void,
    pick: () => Promise<File | null>): ContextMenuEntry[] {
    const attempt = (action: () => void | Promise<void>) => () => {
        try { void Promise.resolve(action()).catch(fail); } catch (error) { fail(error); }
    };
    const rowState: { disabled?: true; reason?: string } = selection.blocked === null ? {} : { disabled: true, reason: selection.blocked };
    if (selection.kind === 'linkcard') {
        return [{ kind: 'command', id: 'media-card-preview', label: 'Fetch link preview', ...rowState,
            run: attempt(() => actions.cardPreview(selection.id)) }];
    }
    const rows: ContextMenuEntry[] = [];
    if (selection.replaceable) {
        rows.push({ kind: 'command', id: 'media-replace', label: 'Replace picture…', ...rowState,
            run: attempt(async () => { const file = await pick(); if (file) await actions.replace(selection.id, file, file.name); }) });
    }
    rows.push({ kind: 'submenu', id: 'media-crop', label: 'Crop picture', ...rowState,
        entries: CROP_ROWS.map(({ preset, label }) => ({ kind: 'command' as const, id: `media-crop-${preset}`, label, ...rowState,
            run: attempt(() => actions.crop(selection.id, preset)) })) });
    rows.push({ kind: 'command', id: 'media-invert', label: 'Invert picture', ...rowState,
        run: attempt(() => actions.invert(selection.id)) });
    return rows;
}

interface ViewBinding {
    readonly controller: ReturnType<typeof createNativeClipboardController>;
    readonly surface: HTMLElement;
    readonly theme: () => 'light' | 'dark';
    readonly notice: (message: string) => void;
    readonly writable: () => boolean;
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
    readonly memory: MemoryAllocator;
    readonly readMedia: (entry: MediaEntry, signal: AbortSignal) => Promise<Blob | null>;
    readonly storeMedia: StoreMedia;
    /** The one picture/card action provider for this document; every view's menu reads its selection. */
    readonly media: MediaActions;
    theme(): 'light' | 'dark';
    attach(surface: HTMLElement, lease: NativeViewLease, theme: () => 'light' | 'dark', notice: (message: string) => void,
        inputHandled?: boolean, writable?: () => boolean): NativeClipboardBinding;
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
    const readMedia = async (entry: MediaEntry, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (identity.kind !== 'pdfInk') return (await ports.read(entry, signal))?.blob ?? null;
        const source = pdfSource();
        const blob = runtime.media.get(entry.id) ?? await source.readMedia(entry.id, signal);
        signal.throwIfAborted();
        if (!current() || pdfSource() !== source) throw new DOMException('PDF media source changed', 'AbortError');
        return blob;
    };
    // Board bytes reach the host only through this guard; replacing a picture and pasting media share it.
    const restoreMedia = (entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null> => {
        signal.throwIfAborted();
        if (!current() || !host.canWrite(identity)) return Promise.reject(new DOMException('Board media source changed', 'AbortError'));
        return ports.restore(entry, blob, signal);
    };
    const storeMedia: StoreMedia = identity.kind === 'pdfInk'
        ? createPdfEmbeddedMediaStorage({ runtime, host, identity, issue: issueMediaStorageReceipt })
        : restoreMedia;
    // A PDF annotation page's pictures live in the PDF, so replacing one needs that page's own storage port, which is not built yet.
    const mediaActions = createMediaActions({ runtime, memory, environment: { appOrigin: location.origin }, current,
        ...(identity.kind === 'pdfInk' ? {} : { restore: restoreMedia }) });
    const ingestor = createBoardMediaIngestor({ runtime, memory, current, finishGesture, storeMedia,
        noticeRefused: files => report(files.map(file => `${file.name}: ${file.reason}`).join('; ')) });
    let commands: ReturnType<typeof createNativeClipboardCommands>;
    try {
        commands = createNativeClipboardCommands({ runtime, token, memory, cache: host.clipboard, current,
            captureWriteAuthority: () => { const captured = active; return () => !!captured && bindings.has(captured) && captured.writable(); },
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
                // Both items come from one frozen export job: the public PNG and our density-carrying private copy.
                const image = capture.then(pair => pair.image), privateImage = capture.then(pair => pair.privateImage);
                void image.catch(() => {}); void privateImage.catch(() => {});
                return navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'web image/x-board+png': privateImage })]);
            },
            copySvg: capture => {
                const text = capture.then(blob => new Blob([blob], { type: 'text/plain' }));
                void text.catch(() => {});
                return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
            },
            download: downloadBoardExport,
        });
    } catch (error) { stopPreferences(); preferenceLifetime.abort(); ingestor.dispose(); cache.close(); throw error; }
    const service: NativeClipboardService = {
        preferences, memory, readMedia, storeMedia, media: mediaActions,
        theme: () => active?.theme() ?? 'light',
        attach(surface, lease, theme, notice, inputHandled = false, writable) {
            if (disposed || !current() || lease.runtime !== runtime) throw new Error('Clipboard document is no longer current');
            let detached = false;
            const canWriteView = () => !detached && current() && !!writable?.() && host.canWrite(identity);
            let pointer: { x: number; y: number } | null = null;
            // A print belongs to this view: detaching the view (pane hide, close, vault switch) cancels it.
            const printing = new AbortController();
            const surfacePoint = (x: number, y: number) => {
                const bounds = surface.getBoundingClientRect(), viewport = lease.camera.viewport;
                if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Board surface is unavailable');
                return { x: (x - bounds.left) * viewport.width / bounds.width, y: (y - bounds.top) * viewport.height / bounds.height };
            };
            const editingText = () => {
                const focused = document.activeElement;
                return focused instanceof HTMLElement && focused !== surface && surface.contains(focused)
                    && (focused.isContentEditable || focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused.classList.contains('wb-edit-host'));
            };
            const controller = createNativeClipboardController({ runtime, host, identity, memory, ingestor, camera: lease.camera,
                pasteAtCursor: () => preferences.getSnapshot().session.pasteAtCursor, pointer: () => pointer, surfacePoint, editingText, canWriteView, finishGesture,
                pinClipboard: () => commands.clipboardCopy.pin(), readMedia, storeMedia, notice: report, onError: fail });
            controllers.add(controller);
            const binding: ViewBinding = { controller, surface, theme, notice, writable: canWriteView }; bindings.add(binding); active = binding;
            const focus = () => { active = binding; };
            const move = (event: PointerEvent) => { focus(); try { pointer = surfaceToWorld(surfacePoint(event.clientX, event.clientY), lease.camera.camera); } catch { pointer = null; } };
            const copy = (event: ClipboardEvent) => { if (!editingText()) { event.preventDefault(); focus(); commands.copyEvent(event); } };
            const cut = (event: ClipboardEvent) => { if (!editingText()) { event.preventDefault(); if (canWriteView()) { focus(); commands.copyEvent(event, true); } } };
            const paste = (event: ClipboardEvent) => { if (canWriteView()) { focus(); controller.pasteEvent(event); } };
            const keydown = (event: KeyboardEvent) => {
                if (editingText()) return;
                focus();
                if (!inputHandled && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
                    const state = runtime.selection.getSnapshot();
                    runtime.selection.replace(selectAllAtFocus(runtime.session.doc, state.sheet, state.focus));
                    event.preventDefault(); event.stopPropagation(); return;
                }
                if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
                    event.preventDefault(); event.stopPropagation(); void commands.copyAsPng(); return;
                }
                // Mod-P belongs to the focused board only: the browser's page print of the app is never reached from here.
                if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
                    event.preventDefault(); event.stopPropagation();
                    void printFocusedBoard({ runtime, kind: identity.kind, boardName: host.identity(identity.documentId)?.name ?? identity.name,
                        transparent: runtime.session.doc.view.transparent, readMedia, valid: () => current() && bindings.has(binding),
                        notice: report, onError: fail }, printing.signal).catch(fail);
                    return;
                }
                if (canWriteView()) {
                    if (!inputHandled && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
                        event.preventDefault(); event.stopPropagation(); void commands.duplicate(); return;
                    }
                    controller.keydown(event);
                }
            };
            const dragover = (event: DragEvent) => { if (canWriteView()) controller.dragover(event); };
            const drop = (event: DragEvent) => { if (canWriteView()) { focus(); controller.drop(event); } };
            const menu = (event: MouseEvent) => {
                event.preventDefault(); event.stopPropagation(); focus();
                const selected = runtime.selection.getSnapshot().selected.length > 0, readonly = !canWriteView();
                const disabled = !selected, why = 'Select content to copy.';
                const entries: ContextMenuEntry[] = [
                    { kind: 'command', id: 'copy', label: 'Copy', disabled, ...(disabled ? { reason: why } : {}), run: commands.copy },
                    { kind: 'command', id: 'copy-png', label: 'Copy as PNG', run: commands.copyAsPng },
                    { kind: 'command', id: 'copy-svg', label: 'Copy as SVG', run: commands.copyAsSvg },
                    { kind: 'command', id: 'copy-json', label: 'Copy as JSON', run: commands.copyAsJson },
                    { kind: 'command', id: 'export-png', label: 'Export PNG', run: () => commands.exportPng('context') },
                    { kind: 'command', id: 'export-svg', label: 'Export SVG', run: () => commands.exportSvg('context') },
                    { kind: 'command', id: 'paste', label: 'Paste', disabled: readonly, ...(readonly ? { reason: 'This canvas is read-only.' } : {}), run: () => controller.paste() },
                ];
                const media = mediaActions.selection(!readonly);
                if (media) entries.push({ kind: 'separator', id: 'media-separator' }, ...mediaRows(media, mediaActions, fail, chooseReplacementImage));
                // A video's or an animated picture's start row exists only after its image has been drawn in this view, or while it
                // plays (so it can stop). Each is named for what it plays.
                if ((media?.video || media?.animated) && (lease.video.shown(media.id) || lease.video.playing(media.id))) {
                    const playing = lease.video.playing(media.id), noun = media.video ? 'video' : 'animation';
                    entries.push({ kind: 'command', id: 'media-playback', label: playing ? `Pause ${noun}` : `Play ${noun}`,
                        run: () => { try { if (playing) lease.video.pause(media.id); else lease.video.play(media.id); } catch (error) { fail(error); } } });
                }
                openContextMenu({ x: event.clientX, y: event.clientY, label: 'Canvas', opener: surface, entries });
            };
            surface.addEventListener('focus', focus); surface.addEventListener('pointermove', move);
            surface.addEventListener('copy', copy); surface.addEventListener('cut', cut); surface.addEventListener('keydown', keydown);
            if (!inputHandled) {
                surface.addEventListener('paste', paste);
                surface.addEventListener('dragover', dragover); surface.addEventListener('drop', drop); surface.addEventListener('contextmenu', menu);
            }
            return { controller, commands, openMenu: menu, focus, detach() {
                if (detached) return; detached = true;
                printing.abort(new DOMException('Board view detached', 'AbortError'));
                bindings.delete(binding); if (active === binding) active = bindings.values().next().value;
                controller.retire(() => controllers.delete(controller));
                surface.removeEventListener('focus', focus); surface.removeEventListener('pointermove', move);
                surface.removeEventListener('copy', copy); surface.removeEventListener('cut', cut); surface.removeEventListener('keydown', keydown);
                if (!inputHandled) {
                    surface.removeEventListener('paste', paste);
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
