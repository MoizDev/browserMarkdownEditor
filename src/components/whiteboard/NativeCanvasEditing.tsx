import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { getBoardPreferences, mouseZoomInverted } from '../../utils/boardPreferences';
import { getContextMenu } from '../../utils/contextMenu';
import { translateBoard } from '../../whiteboard/chrome/language';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import { localizeBoardChrome } from './chrome/localize';
import { useBoardDebugSampler } from './useBoardDebugSampler';
import type { CommandState } from './chrome/boardCommands';
import type { createBoardStyleControls } from '../../whiteboard/host/styleControls';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import { getBoardRuntime } from '../../whiteboard/host/runtime';
import { FIGURE_SHAPES, type FigureShape } from '../../whiteboard/model/styles';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import type { NativeCanvasEntryProps, NativeEditingChromeContext } from './NativeCanvasEntry';
import { NativeBoardChromeHost } from './NativeBoardChromeHost';
import { createNativeBoardActions } from './nativeBoardActions';
import { createNativeBoardContextMenu } from './nativeBoardContextMenu';
import type { NativeEmbedController } from '../../whiteboard/host/nativeEmbeds';
import { createNativeBoardOperations } from './nativeBoardOperations';
import { createNativeCameraOperations } from './nativeCameraOperations';
import { createNativeKeyCommands, nativeActionShortcut, nativeCommandShortcut } from './nativeCommandSource';
import { createNativeEditingKeyboard } from './nativeEditingKeyboard';
import { chooseReplacementImage, type MediaRowId } from './nativeMediaRows';
import { NativeCropDialog, type CropWindow } from './NativeCropDialog';
import type { NativeEditingCapabilities, NativeEditingCapabilityFactory } from './nativeEditingCapabilities';
import { createNativeLinkOperations } from './nativeLinkOperations';
import type { createNativeViewLease, NativeViewLease } from './nativeViewLease';
import { documentClipboard, type NativeClipboardService } from './useNativeClipboard';
import { useNativeBoardDialogs } from './useNativeBoardDialogs';
import { useNativeBoardLanguage } from './useNativeBoardLanguage';
import { isCancellation } from '../../platform/workers/envelope';

interface CropOpen { readonly id: MediaRowId; readonly url: string; readonly width: number; readonly height: number; readonly window: CropWindow; readonly circle: boolean }

type Links = ReturnType<typeof createNativeLinkOperations>;
type Styles = ReturnType<typeof createBoardStyleControls>;
export type NativeEditingViewProps = Pick<NativeCanvasEntryProps, 'identity' | 'nativeCanvasHost' | 'isVisible' | 'isFocused' | 'theme'>;
export type NativeEditingViewOptions = NonNullable<Parameters<typeof createNativeViewLease>[0]['editing']>;
export interface NativeEditingRenderContext {
    readonly lease: NativeViewLease;
    readonly chrome: (context: NativeEditingChromeContext) => ReactNode;
    readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void;
    readonly notice: string | null;
    /** null dismisses the notice shown. */
    readonly setNotice: (value: string | null) => void;
    readonly editable: boolean;
    readonly canMutate: () => boolean;
}

/** This mounts actual editing input and chrome against the acquired document. The temporary
 * admission seal remains until the complete per-embed presentation service is connected. */
export function NativeCanvasEditing({ props, board, adapter, factory, createLease, renderView, inversion, onError, onUnavailable }: {
    readonly props: NativeEditingViewProps;
    readonly board: ComposedBoardSession;
    readonly adapter: HostedBoardAdapter<BoardSessionPort>;
    readonly factory: NativeEditingCapabilityFactory;
    readonly createLease: (editing: NativeEditingViewOptions, signal: AbortSignal, notice: (message: string) => void,
        clearNotice: (message: string) => void) => Promise<NativeViewLease>;
    readonly renderView: (context: NativeEditingRenderContext) => ReactNode;
    /** PDF keeps its existing view preference outside the retokened shell. */
    readonly inversion?: { readonly value: boolean; readonly set: (value: boolean) => void };
    readonly onError: (error: unknown) => void;
    readonly onUnavailable: (error: unknown) => void;
}) {
    const runtime = getBoardRuntime(board);
    if (!runtime || runtime.session !== board) throw new Error('Native editor requires the acquired board runtime');
    const { identity, nativeCanvasHost: host } = props;
    const current = useCallback(() => host.isCurrent(identity), [host, identity]);
    const language = useNativeBoardLanguage(onUnavailable);
    const dialogs = useNativeBoardDialogs({ documentId: identity.documentId, session: identity.session, isVisible: props.isVisible, currentOwner: current });
    const importNotice = adapter.importNotice;
    const [notice, setNotice] = useState<string | null>(() => importNotice && !importNotice.isDismissed() ? importNotice.text : null);
    const [localInverted, setLocalInverted] = useState(false);
    // Dismissed or replaced, the conversion notice is done for this session.
    useEffect(() => { if (importNotice && notice !== importNotice.text) importNotice.dismiss(); }, [importNotice, notice]);
    const inverted = inversion?.value ?? localInverted, setInverted = inversion?.set ?? setLocalInverted;
    const [lease, setLease] = useState<NativeViewLease | null>(null), [clipboard, setClipboard] = useState<NativeClipboardService | null>(null);
    const [capabilities, setCapabilities] = useState<NativeEditingCapabilities | null>(null), [attached, setAttached] = useState(false);
    const commandRef = useRef<((id: string, event: KeyboardEvent) => boolean) | null>(null), linksRef = useRef<Links | null>(null);
    const contextMenuRef = useRef<ReturnType<typeof createNativeBoardContextMenu> | null>(null), embedControllerRef = useRef<NativeEmbedController | null>(null);
    const [lifetime, setLifetime] = useState<AbortController | null>(null);
    const viewRef = useRef<NativeViewLease | null>(null), chromeMountedRef = useRef(false), styleRef = useRef<Styles | null>(null);
    // Populated only when the real presentation port AND semantic per-node Load service are attached.
    const embedPortRef = useRef<EmbedPresentationPort | null>(null);
    const [embedPort, setEmbedPort] = useState<EmbedPresentationPort | null>(null);
    // The per-session view preferences live with the clipboard service; the input layer reads them live through this ref.
    const sessionPreferencesRef = useRef<BoardPreferenceState | null>(null);
    useEffect(() => { sessionPreferencesRef.current = clipboard?.preferences ?? null; }, [clipboard]);
    const canMutateView = useCallback(() => !!viewRef.current?.editing?.isAttached() && chromeMountedRef.current && !!styleRef.current && !!embedPortRef.current, []);
    const onChromeReady = useCallback((ready: boolean) => { chromeMountedRef.current = ready; }, []);
    const report = useCallback((error: unknown) => {
        if (!isCancellation(error)) setNotice(error instanceof Error ? error.message : String(error));
    }, []);
    useEffect(() => {
        if (!props.isVisible) return;
        const controller = new AbortController(); setLifetime(controller);
        let live = true, view: NativeViewLease | undefined, owned: NativeEditingCapabilities | undefined;
        void (async () => {
        try {
            const service = documentClipboard(runtime, host, identity);
            const editing: NativeEditingViewOptions = { clipboard: service, canMutate: canMutateView,
                onEmbedInfrastructure(value) {
                    embedControllerRef.current = value?.controller ?? null;
                    embedPortRef.current = value?.port ?? null;
                    if (live) setEmbedPort(value?.port ?? null);
                },
                onAttachment(value) { if (live) setAttached(value); },
                    commands: { run(id, event) { const run = commandRef.current; if (!run) throw new Error('Board commands are not attached'); return run(id, event); } },
                    ui: { mac: /Mac|iPhone|iPad/.test(navigator.platform), shortcutsEnabled: () => getBoardPreferences().areKeyboardShortcutsEnabled,
                        edgeScrolling: () => sessionPreferencesRef.current?.getSnapshot().session.edgeScrolling ?? true, invertMouseZoom: mouseZoomInverted,
                        // The chips on an embed or link card: consent and the controller are the embed host's; the address and preview are the card's own.
                        cards: { embedState: id => embedControllerRef.current?.state(id) ?? 'inert',
                            loadEmbed(id) { const target = embedControllerRef.current; return target ? target.load(id) : Promise.reject(new Error('Embeds are unavailable')); },
                            unloadEmbed(id) { return embedControllerRef.current?.unload(id) ?? Promise.resolve(); },
                            subscribeEmbeds(listener) { return embedControllerRef.current?.subscribe(listener) ?? (() => {}); },
                            openLink(url) { const target = linksRef.current; if (!target) throw new Error('Link actions are unavailable'); target.openLink(url); },
                            fetchPreview: id => service.media.cardPreview(id) },
                        modalOpen: () => !!getContextMenu() || !!document.querySelector('[aria-modal="true"]'),
                        isDirectPen: event => event.pointerType === 'pen' && navigator.maxTouchPoints > 0,
                        ownsWheel: event => !event.composedPath().some(target => target instanceof Element &&
                            target.matches('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]')),
                        error: report, notice: setNotice, contextMenu(request) { const menu = contextMenuRef.current; if (!menu) throw new Error('Board context menu is unavailable'); menu.pointer(request); },
                        openKeyboardContextMenu(request) { const menu = contextMenuRef.current; if (!menu) throw new Error('Board context menu is unavailable'); menu.keyboard(request); },
                        penModeChanged(enabled) { viewRef.current?.editing?.announce(enabled ? 'Pen mode enabled.' : 'Pen mode disabled.'); },
                        text: { openLink(url) { const target = linksRef.current; if (!target) throw new Error('Link actions are unavailable'); target.openLink(url); },
                            command(name) { const target = linksRef.current; if (name !== 'link' || !target) throw new Error('Text command is unavailable'); void target.editText().catch(report); },
                            touchHandles(show) { viewRef.current?.editing?.announce(show ? 'Text selection handles shown.' : 'Text selection handles hidden.'); },
                            reducedMotion: () => getBoardPreferences().animationSpeed === 0,
                            dynamicTextSize: () => getBoardPreferences().isDynamicResizeMode } } };
            view = await createLease(editing, controller.signal, setNotice, message => setNotice(shown => shown === message ? null : shown));
            if (!live || controller.signal.aborted || !current()) { view.dispose(); return; }
            viewRef.current = view; setClipboard(service); setLease(view);
            const acquired = view;
            void factory({ runtime, lease: acquired, host, identity, clipboard: service, signal: controller.signal,
                current: () => current() && acquired.isCurrent(), canWrite: () => canMutateView() && host.canWrite(identity),
                requestText: dialogs.requestText, notice: setNotice }).then(value => {
                if (!live || controller.signal.aborted || !current()) { value.dispose(); return; }
                owned = value; setCapabilities(value);
            }, error => { if (live && !controller.signal.aborted) onUnavailable(error); });
        } catch (error) { if (live && !controller.signal.aborted) onUnavailable(error); }
        })();
        return () => { live = false; controller.abort(); setLifetime(previous => previous === controller ? null : previous); owned?.dispose();
            setCapabilities(null); setAttached(false); setLease(previous => previous === view ? null : previous); setClipboard(null);
            if (viewRef.current === view) viewRef.current = null; view?.dispose(); };
    }, [props.isVisible, runtime, host, identity, factory, createLease, current, canMutateView, dialogs.requestText, report, onUnavailable]);
    if (!props.isVisible) return null;
    if (!lease || !clipboard || !capabilities || !language || !lifetime) return <>{dialogs.dialogs}<div role="status">Preparing canvas editor…{notice && ` ${notice}`}</div></>;
    return <ConnectedEditor props={props} lease={lease} adapter={adapter} clipboard={clipboard} capabilities={capabilities}
        language={language} signal={lifetime.signal} dialogs={dialogs} current={current} report={report} notice={notice}
        setNotice={setNotice} inverted={inverted} setInverted={setInverted} attached={attached} commandRef={commandRef} linksRef={linksRef}
        canMutateView={canMutateView} onChromeReady={onChromeReady} embedPort={embedPort} contextMenuRef={contextMenuRef}
        embedControllerRef={embedControllerRef} styleRef={styleRef} renderView={renderView} />;
}

function ConnectedEditor({ props, lease, adapter, clipboard, capabilities, language, signal, dialogs, current: ownerCurrent, report,
    notice, setNotice, inverted, setInverted, attached, commandRef, linksRef, canMutateView, onChromeReady, embedPort,
    contextMenuRef, embedControllerRef, styleRef, renderView }: {
    readonly props: NativeEditingViewProps; readonly lease: NativeViewLease; readonly adapter: HostedBoardAdapter<BoardSessionPort>;
    readonly clipboard: NativeClipboardService; readonly capabilities: NativeEditingCapabilities;
    readonly language: NonNullable<ReturnType<typeof useNativeBoardLanguage>>; readonly signal: AbortSignal;
    readonly dialogs: ReturnType<typeof useNativeBoardDialogs>; readonly current: () => boolean; readonly report: (error: unknown) => void;
    readonly notice: string | null; readonly setNotice: (message: string | null) => void; readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void; readonly attached: boolean;
    readonly commandRef: RefObject<((id: string, event: KeyboardEvent) => boolean) | null>; readonly linksRef: RefObject<Links | null>;
    readonly renderView: (context: NativeEditingRenderContext) => ReactNode;
    readonly canMutateView: () => boolean; readonly onChromeReady: (ready: boolean) => void;
    readonly embedPort: EmbedPresentationPort | null;
    readonly contextMenuRef: RefObject<ReturnType<typeof createNativeBoardContextMenu> | null>;
    readonly embedControllerRef: RefObject<NativeEmbedController | null>;
    readonly styleRef: RefObject<Styles | null>;
}) {
    const runtime = lease.runtime, host = props.nativeCanvasHost, identity = props.identity;
    useBoardDebugSampler(runtime, lease);
    const current = useCallback(() => ownerCurrent() && lease.isCurrent(), [ownerCurrent, lease]);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const shortcutRef = useRef<(() => void) | null>(null);
    const [chromeReady, setChromeReady] = useState(false), [thumbnails, setThumbnails] = useState(false);
    const [servicesEpoch, refreshServices] = useState(0);
    const minimapRef = useRef(false), setMinimapRef = useRef<((value: boolean) => void) | null>(null);
    const minimapVisible = useCallback(() => minimapRef.current, []);
    const setMinimapVisible = useCallback((value: boolean) => { if (!setMinimapRef.current) throw new Error('Minimap view is not attached'); setMinimapRef.current(value); }, []);
    const bindMinimap = useCallback((context: NativeEditingChromeContext) => {
        minimapRef.current = context.minimapOpen; setMinimapRef.current = context.setMinimapOpen;
        return () => { if (setMinimapRef.current === context.setMinimapOpen) setMinimapRef.current = null; };
    }, []);
    const shortcutsAvailable = useCallback(() => !!shortcutRef.current, []);
    const openShortcuts = useCallback(() => { if (!shortcutRef.current) throw new Error('Shortcuts are unavailable'); shortcutRef.current(); }, []);
    const canWrite = useCallback(() => canMutateView() && host.canWrite(identity), [canMutateView, host, identity]);
    // The crop editor's one open picture: its original, read for this editor and released when the editor closes.
    const [crop, setCrop] = useState<CropOpen | null>(null);
    useEffect(() => { if (!crop) return; const url = crop.url; return () => URL.revokeObjectURL(url); }, [crop]);
    const openCrop = useCallback((id: MediaRowId) => {
        const info = clipboard.media.cropSource(id);
        if (!info) { report(new Error('This picture cannot be cropped.')); return; }
        clipboard.media.readOriginal(id, signal).then(blob => {
            if (!blob) throw new Error('The picture bytes are unavailable.');
            if (signal.aborted) return;
            setCrop({ id, url: URL.createObjectURL(blob), width: info.width, height: info.height, window: info.window, circle: info.circle });
        }).catch(error => { if (!isCancellation(error)) report(error); });
    }, [clipboard, report, signal]);
    const closeCrop = useCallback(() => setCrop(null), []);
    const confirmCrop = useCallback((frame: CropWindow, circle: boolean) => {
        const open = crop;
        setCrop(null);
        if (!open) return;
        try { clipboard.media.cropWindow(open.id, frame, circle); } catch (error) { report(error); }
    }, [crop, clipboard, report]);
    const cropDialog = crop ? <NativeCropDialog key={crop.url} url={crop.url} width={crop.width} height={crop.height}
        initial={crop.window} initialCircle={crop.circle} onConfirm={confirmCrop} onCancel={closeCrop} /> : null;
    const link = useMemo(() => createNativeLinkOperations({ runtime, lease, current, canWrite,
        requestText: dialogs.requestText, requestTextChoice: dialogs.requestTextChoice, notice: setNotice }), [runtime, lease, current, canWrite, dialogs.requestText, dialogs.requestTextChoice, setNotice]);
    useLayoutEffect(() => { linksRef.current = link; return () => { if (linksRef.current === link) linksRef.current = null; }; }, [linksRef, link]);
    // Print and PDF export belong to the clipboard service that owns this board's focused print pin.
    const runPrint = useCallback(() => clipboard.print(), [clipboard]);
    const runExportPdf = useCallback(() => clipboard.exportPdf(), [clipboard]);
    const [owned, setOwned] = useState<{ camera: ReturnType<typeof createNativeCameraOperations>;
        commands: ReturnType<typeof createNativeBoardOperations> } | null>(null);
    useEffect(() => {
        const camera = createNativeCameraOperations({ runtime, lease, current, signal, minimapVisible, setMinimapVisible });
        const actions = createNativeBoardActions({ lease, capabilities, camera, shortcutsAvailable, openShortcuts, print: runPrint, exportPdf: runExportPdf });
        const labels = localizeBoardChrome((key, values) => translateBoard(language.getSnapshot().table, key, values));
        const commands = createNativeBoardOperations({ runtime, lease, current, canWrite,
            frameName: () => 'Frame', flatten: capabilities.flatten, editLink: link.editLink, actions,
            keptLockedNotice: count => translateBoard(language.getSnapshot().table, 'notice.keptLocked', { count }),
            label: labels.commandLabel, shortcut: id => nativeCommandShortcut(id, mac), actionLabel: labels.actionLabel,
            actionShortcut: id => nativeActionShortcut(id, mac), notice: setNotice, onError: report });
        const value = { camera, commands }; setOwned(value);
        return () => setOwned(previous => previous === value ? null : previous);
    }, [runtime, lease, current, signal, minimapVisible, setMinimapVisible, capabilities, shortcutsAvailable, openShortcuts,
        language, canWrite, link, mac, setNotice, report, runPrint, runExportPdf]);
    useLayoutEffect(() => {
        if (!owned) return;
        const { commands, camera } = owned;
        const extra = createNativeEditingKeyboard({ runtime, lease, commands, camera, preferences: clipboard.preferences,
            openShortcuts: () => { if (!shortcutRef.current) return false; shortcutRef.current(); return true; },
            // I inverts the one picture selected, and does nothing when no picture is (it is never a page command).
            invertPicture: () => {
                const picture = clipboard.media.selection(canWrite());
                if (!picture || picture.kind !== 'picture' || picture.blocked !== null || picture.video) return false;
                try { clipboard.media.invert(picture.id); } catch (error) { report(error); }
                return true;
            },
            current, canWrite, report });
        const keys = createNativeKeyCommands(commands, id => extra(id)); commandRef.current = keys.run;
        const openMenu = createNativeBoardContextMenu({ runtime, commands, language, preferences: clipboard.preferences,
            embed: () => embedPort ? embedControllerRef.current : null,
            openLink(url) { const target = linksRef.current; if (!target) throw new Error('Link actions are unavailable'); target.openLink(url); },
            media: () => ({ actions: clipboard.media, selection: writable => clipboard.media.selection(writable), fail: report,
                pick: chooseReplacementImage, requestText: dialogs.requestText, playback: lease.video, openCrop }),
            current, canWrite, notice: setNotice, zoom: () => lease.camera.camera.z });
        contextMenuRef.current = openMenu;
        return () => { if (commandRef.current === keys.run) commandRef.current = null;
            if (contextMenuRef.current === openMenu) contextMenuRef.current = null; };
    }, [commandRef, contextMenuRef, embedControllerRef, embedPort, runtime, lease, owned, clipboard, language, current, canWrite, report, setNotice,
        dialogs.requestText, openCrop, linksRef]);
    const registerShortcuts = useCallback((open: () => void) => {
        shortcutRef.current = open; refreshServices(value => value + 1);
        return () => { if (shortcutRef.current === open) shortcutRef.current = null; };
    }, []);
    const onStyles = useCallback((value: Styles | null) => {
        styleRef.current = value; refreshServices(epoch => epoch + 1);
    }, [styleRef]);
    const handleChromeReady = useCallback((ready: boolean) => { onChromeReady(ready); setChromeReady(ready); }, [onChromeReady]);
    const toolStateFor = useCallback((id: string, figure?: string): CommandState => {
        if (adapter.board.isReadOnly || !canWrite()) return { enabled: false, reason: adapter.board.readOnlyReason ?? 'Board is read-only' };
        if (!runtime.tools.getRegistration(id) || (id === 'figure' && figure && !FIGURE_SHAPES.includes(figure as FigureShape))) return { enabled: false, reason: 'Tool is unavailable' };
        return { enabled: true };
    }, [adapter, canWrite, runtime]);
    const editingChrome = useCallback((context: NativeEditingChromeContext) => {
        if (!owned) throw new Error('Board commands are not attached');
        const { commands } = owned;
        return <NativeChromeAttachment context={context} bind={bindMinimap}><NativeBoardChromeHost runtime={runtime} engine={lease.engine} lease={lease} language={language} preferences={clipboard.preferences} capturePage={clipboard.pagePng}
            currentOwner={current} mac={mac} isVisible={props.isVisible}
            readOnly={adapter.board.isReadOnly || !canWrite()} readOnlyReason={adapter.board.readOnlyReason ?? 'Board editing services are not ready'} reportError={report}
            toolStateFor={toolStateFor} commands={commands} actionShortcut={commands.actionShortcut} actionState={commands.actionState}
            runAction={commands.runAction} openMedia={() => { void commands.runAction('uploadMedia'); }} zoom={context.zoom}
            minimapVisible={context.minimapOpen} confirm={dialogs.confirm} canWrite={canWrite} registerShortcuts={registerShortcuts} onReady={handleChromeReady} onStyles={onStyles}
            notebook={runtime.session.doc.kind !== 'whiteboard' ? { inverted, setInverted, thumbnailsOpen: thumbnails, setThumbnailsOpen: setThumbnails } : undefined} /></NativeChromeAttachment>;
    }, [runtime, lease, language, clipboard, current, mac, props.isVisible, adapter, canWrite, report, toolStateFor, owned, dialogs.confirm, registerShortcuts, onStyles, handleChromeReady, inverted, setInverted, thumbnails, bindMinimap]);
    useEffect(() => {
        if (!props.isVisible || signal.aborted || !current() || !attached || !chromeReady || !owned || !embedPort
            || !lease.editing?.isAttached() || !lease.editing.getTools() || !styleRef.current || !shortcutRef.current
            || !commandRef.current || !contextMenuRef.current || !canMutateView()) return;
        try {
            if (!host.canWriteSource(identity)) return;
            if (!adapter.activateEditing) throw new Error('The native session has no editing admission');
            // The real view services exist before removing the temporary seal.
            // Final canWrite includes that seal, so checking it first deadlocks admission.
            const wasReadOnly = adapter.board.isReadOnly;
            adapter.activateEditing();
            if (!host.canWrite(identity) || adapter.board.isReadOnly) throw new Error(adapter.board.readOnlyReason ?? 'The canvas source is not writable');
            lease.refreshAuthority();
            if (wasReadOnly) refreshServices(epoch => epoch + 1);
        } catch (error) { report(error); }
    }, [props.isVisible, signal, current, attached, chromeReady, owned, embedPort, lease, styleRef, commandRef,
        contextMenuRef, canMutateView, host, identity, adapter, servicesEpoch, report]);

    if (!owned) return <>{dialogs.dialogs}<div role="status">Preparing board commands…</div></>;
    return <>{dialogs.dialogs}{cropDialog}{renderView({ lease, chrome: editingChrome, inverted, setInverted, notice, setNotice,
            editable: attached && chromeReady && !!embedPort && !adapter.board.isReadOnly && host.canWrite(identity),
            canMutate: lease.canMutateView })}</>;
}

function NativeChromeAttachment({ context, bind, children }: { readonly context: NativeEditingChromeContext;
    readonly bind: (context: NativeEditingChromeContext) => () => void; readonly children: ReactNode }) {
    const { minimapOpen, setMinimapOpen } = context;
    useLayoutEffect(() => bind({ ...context, minimapOpen, setMinimapOpen }), [bind, context, minimapOpen, setMinimapOpen]);
    return children;
}
