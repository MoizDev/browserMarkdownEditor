import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { getBoardPreferences, mouseInputChosen, mouseZoomInverted } from '../../utils/boardPreferences';
import { getContextMenu } from '../../utils/contextMenu';
import { translateBoard } from '../../whiteboard/chrome/language';
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
import { NativePictureCrop, NativePictureToolbar } from './NativePictureCrop';
import type { NativeEditingCapabilities, NativeEditingCapabilityFactory } from './nativeEditingCapabilities';
import { createNativeLinkOperations } from './nativeLinkOperations';
import type { createNativeViewLease, NativeViewLease } from './nativeViewLease';
import { documentClipboard, type NativeClipboardService } from './useNativeClipboard';
import { useNativeBoardDialogs } from './useNativeBoardDialogs';
import { useNativeBoardLanguage } from './useNativeBoardLanguage';
import { isCancellation } from '../../platform/workers/envelope';
import { useBoardNotices, type BoardNotices } from './boardNotices';
import { DISK_CHANGED_BOARD_NOTICE, DISK_DELETED_BOARD_NOTICE } from '../../utils/diskHeldNotice';


type Links = ReturnType<typeof createNativeLinkOperations>;
type Styles = ReturnType<typeof createBoardStyleControls>;
export type NativeEditingViewProps = Pick<NativeCanvasEntryProps, 'identity' | 'nativeCanvasHost' | 'isVisible' | 'isFocused' | 'theme' | 'diskHeld'>;
export type NativeEditingViewOptions = NonNullable<Parameters<typeof createNativeViewLease>[0]['editing']>;
export interface NativeEditingRenderContext {
    readonly lease: NativeViewLease;
    readonly chrome: (context: NativeEditingChromeContext) => ReactNode;
    readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void;
    /** The board's notices, shown together (boardNotices.tsx). */
    readonly notices: BoardNotices;
    readonly editable: boolean;
    /** Editing is still being admitted: the session is sealed read-only only until its services connect (or admission fails). */
    readonly admitting: boolean;
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
    // The capability factory's translator outlives the render that created it, so it reads the language through a ref.
    const languageRef = useRef(language);
    useLayoutEffect(() => { languageRef.current = language; }, [language]);
    const dialogs = useNativeBoardDialogs({ documentId: identity.documentId, session: identity.session, isVisible: props.isVisible, currentOwner: current });
    const importNotice = adapter.importNotice;
    // Dismissed, the conversion notice is done for this session; another notice beside it no longer counts as dismissing it.
    const dismissImport = useCallback((message: string) => { if (importNotice && message === importNotice.text) importNotice.dismiss(); }, [importNotice]);
    const notices = useBoardNotices(importNotice && !importNotice.isDismissed() ? [importNotice.text] : [], dismissImport);
    const setNotice = notices.show, clearNotice = notices.clear;
    // The DiskBar's question answered, what the board said about it no longer holds (utils/diskHeldNotice.ts).
    const diskHeld = props.diskHeld;
    useEffect(() => {
        if (!diskHeld) { clearNotice(DISK_CHANGED_BOARD_NOTICE); clearNotice(DISK_DELETED_BOARD_NOTICE); }
    }, [diskHeld, clearNotice]);
    const [localInverted, setLocalInverted] = useState(false);
    const inverted = inversion?.value ?? localInverted, setInverted = inversion?.set ?? setLocalInverted;
    const [lease, setLease] = useState<NativeViewLease | null>(null), [clipboard, setClipboard] = useState<NativeClipboardService | null>(null);
    const [capabilities, setCapabilities] = useState<NativeEditingCapabilities | null>(null), [attached, setAttached] = useState(false);
    const commandRef = useRef<((id: string, event: KeyboardEvent) => boolean) | null>(null), linksRef = useRef<Links | null>(null);
    // The palette's opener is registered by ConnectedEditor; the text editor reaches it through this ref (Cmd/Ctrl+K in a text edit).
    const paletteRef = useRef<(() => void) | null>(null);
    const contextMenuRef = useRef<ReturnType<typeof createNativeBoardContextMenu> | null>(null), embedControllerRef = useRef<NativeEmbedController | null>(null);
    const [lifetime, setLifetime] = useState<AbortController | null>(null);
    const viewRef = useRef<NativeViewLease | null>(null), chromeMountedRef = useRef(false), styleRef = useRef<Styles | null>(null);
    // The editing view's keys are bound once per view, so Ctrl/Cmd+P reads the current print route (ConnectedEditor's) through this ref.
    const printRef = useRef<() => boolean>(() => false);
    // Populated only when the real presentation port AND semantic per-node Load service are attached.
    const embedPortRef = useRef<EmbedPresentationPort | null>(null);
    const [embedPort, setEmbedPort] = useState<EmbedPresentationPort | null>(null);
    const canMutateView = useCallback(() => !!viewRef.current?.editing?.isAttached() && chromeMountedRef.current && !!styleRef.current && !!embedPortRef.current, []);
    const onChromeReady = useCallback((ready: boolean) => { chromeMountedRef.current = ready; }, []);
    const report = useCallback((error: unknown) => {
        if (!isCancellation(error)) setNotice(error instanceof Error ? error.message : String(error));
    }, [setNotice]);
    useEffect(() => {
        if (!props.isVisible) return;
        const controller = new AbortController(); setLifetime(controller);
        let live = true, view: NativeViewLease | undefined, owned: NativeEditingCapabilities | undefined;
        void (async () => {
        try {
            const service = documentClipboard(runtime, host, identity);
            const editing: NativeEditingViewOptions = { clipboard: service, canMutate: canMutateView, print: () => printRef.current(),
                onEmbedInfrastructure(value) {
                    embedControllerRef.current = value?.controller ?? null;
                    embedPortRef.current = value?.port ?? null;
                    if (live) setEmbedPort(value?.port ?? null);
                },
                onAttachment(value) { if (live) setAttached(value); },
                    commands: { run(id, event) { const run = commandRef.current; if (!run) throw new Error('Board commands are not attached'); return run(id, event); } },
                    ui: { mac: /Mac|iPhone|iPad/.test(navigator.platform), shortcutsEnabled: () => getBoardPreferences().areKeyboardShortcutsEnabled,
                        edgeScrolling: () => getBoardPreferences().edgeScrolling, mouseWheel: mouseInputChosen, invertMouseZoom: mouseZoomInverted,
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
                        text: { commandPalette() { if (!paletteRef.current) throw new Error('The command palette is not ready'); paletteRef.current(); },
                            openLink(url) { const target = linksRef.current; if (!target) throw new Error('Link actions are unavailable'); target.openLink(url); },
                            command(name) { const target = linksRef.current; if (name !== 'link' || !target) throw new Error('Text command is unavailable'); void target.editText().catch(report); },
                            touchHandles(show) { viewRef.current?.editing?.announce(show ? 'Text selection handles shown.' : 'Text selection handles hidden.'); },
                            reducedMotion: () => getBoardPreferences().animationSpeed === 0,
                            dynamicTextSize: () => getBoardPreferences().isDynamicResizeMode } } };
            view = await createLease(editing, controller.signal, setNotice, clearNotice);
            if (!live || controller.signal.aborted || !current()) { view.dispose(); return; }
            viewRef.current = view; setClipboard(service); setLease(view);
            const acquired = view;
            void factory({ runtime, lease: acquired, host, identity, clipboard: service, signal: controller.signal,
                current: () => current() && acquired.isCurrent(), canWrite: () => canMutateView() && host.canWrite(identity),
                requestText: dialogs.requestText, notice: setNotice, t: key => { const table = languageRef.current?.getSnapshot().table; return table ? translateBoard(table, key) : key; } }).then(value => {
                if (!live || controller.signal.aborted || !current()) { value.dispose(); return; }
                owned = value; setCapabilities(value);
            }, error => { if (live && !controller.signal.aborted) onUnavailable(error); });
        } catch (error) { if (live && !controller.signal.aborted) onUnavailable(error); }
        })();
        return () => { live = false; controller.abort(); setLifetime(previous => previous === controller ? null : previous); owned?.dispose();
            setCapabilities(null); setAttached(false); setLease(previous => previous === view ? null : previous); setClipboard(null);
            if (viewRef.current === view) viewRef.current = null; view?.dispose(); };
    }, [props.isVisible, runtime, host, identity, factory, createLease, current, canMutateView, dialogs.requestText, report, onUnavailable, setNotice, clearNotice]);
    if (!props.isVisible) return null;
    if (!lease || !clipboard || !capabilities || !language || !lifetime) return <>{dialogs.dialogs}<div role="status">Preparing canvas editor…{notices.list.map(message => ` ${message}`).join('')}</div></>;
    return <ConnectedEditor props={props} lease={lease} adapter={adapter} clipboard={clipboard} capabilities={capabilities}
        language={language} signal={lifetime.signal} dialogs={dialogs} current={current} report={report} notices={notices}
        inverted={inverted} setInverted={setInverted} attached={attached} commandRef={commandRef} linksRef={linksRef} paletteRef={paletteRef}
        canMutateView={canMutateView} onChromeReady={onChromeReady} embedPort={embedPort} contextMenuRef={contextMenuRef} printRef={printRef}
        embedControllerRef={embedControllerRef} styleRef={styleRef} renderView={renderView} />;
}

function ConnectedEditor({ props, lease, adapter, clipboard, capabilities, language, signal, dialogs, current: ownerCurrent, report,
    notices, inverted, setInverted, attached, commandRef, linksRef, paletteRef, canMutateView, onChromeReady, embedPort,
    contextMenuRef, embedControllerRef, styleRef, renderView, printRef }: {
    readonly props: NativeEditingViewProps; readonly lease: NativeViewLease; readonly adapter: HostedBoardAdapter<BoardSessionPort>;
    readonly printRef: RefObject<() => boolean>;
    readonly clipboard: NativeClipboardService; readonly capabilities: NativeEditingCapabilities;
    readonly language: NonNullable<ReturnType<typeof useNativeBoardLanguage>>; readonly signal: AbortSignal;
    readonly dialogs: ReturnType<typeof useNativeBoardDialogs>; readonly current: () => boolean; readonly report: (error: unknown) => void;
    readonly notices: BoardNotices; readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void; readonly attached: boolean;
    readonly commandRef: RefObject<((id: string, event: KeyboardEvent) => boolean) | null>; readonly linksRef: RefObject<Links | null>; readonly paletteRef: RefObject<(() => void) | null>;
    readonly renderView: (context: NativeEditingRenderContext) => ReactNode;
    readonly canMutateView: () => boolean; readonly onChromeReady: (ready: boolean) => void;
    readonly embedPort: EmbedPresentationPort | null;
    readonly contextMenuRef: RefObject<ReturnType<typeof createNativeBoardContextMenu> | null>;
    readonly embedControllerRef: RefObject<NativeEmbedController | null>;
    readonly styleRef: RefObject<Styles | null>;
}) {
    const setNotice = notices.show;
    const runtime = lease.runtime, host = props.nativeCanvasHost, identity = props.identity;
    useBoardDebugSampler(runtime, lease);
    const current = useCallback(() => ownerCurrent() && lease.isCurrent(), [ownerCurrent, lease]);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const shortcutRef = useRef<(() => void) | null>(null);
    // The chrome registers its palette opener while mounted; the keyboard and the actions reach it through here.
    const openCommandPalette = useCallback(() => { if (!paletteRef.current) return false; paletteRef.current(); return true; }, [paletteRef]);
    const [chromeReady, setChromeReady] = useState(false), [thumbnails, setThumbnails] = useState(false);
    const [admissionFailed, setAdmissionFailed] = useState(false);
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
    // The menu's crop row starts the same crop the picture's own toolbar and double-click start: one session per document.
    const openCrop = useCallback((id: MediaRowId) => {
        clipboard.crop.open(id).catch(error => { if (!isCancellation(error)) report(error); });
    }, [clipboard, report]);
    const translate = useCallback((key: string) => translateBoard(language.getSnapshot().table, key), [language]);
    const link = useMemo(() => createNativeLinkOperations({ runtime, lease, current, canWrite,
        requestText: dialogs.requestText, requestTextChoice: dialogs.requestTextChoice, notice: setNotice, t: translate }), [runtime, lease, current, canWrite, dialogs.requestText, dialogs.requestTextChoice, setNotice, translate]);
    useLayoutEffect(() => { linksRef.current = link; return () => { if (linksRef.current === link) linksRef.current = null; }; }, [linksRef, link]);
    // Print and PDF export belong to the clipboard service that owns this board's focused print pin.
    // With a selection on a whiteboard, the app's own dialog asks what to print (catalogue c.10): the selection, or the whole sheet.
    // A paged board prints its pages whatever is selected, so it is not asked.
    const runPrint = useCallback((): boolean => {
        if (runtime.session.doc.kind !== 'whiteboard' || !runtime.selection.getSnapshot().selected.length) return clipboard.print();
        void dialogs.chooseOne({ title: translate('chrome.print'), body: translate('print.scopeBody'),
            confirmLabel: translate('palette.selection'), altLabel: translate('chrome.sheet') })
            .then(choice => { if (choice) clipboard.print(choice === 'alt'); }, report);
        return true;
    }, [clipboard, runtime, dialogs, translate, report]);
    const runExportPdf = useCallback(() => clipboard.exportPdf(), [clipboard]);
    useLayoutEffect(() => { printRef.current = runPrint; }, [runPrint, printRef]);
    const [owned, setOwned] = useState<{ camera: ReturnType<typeof createNativeCameraOperations>;
        commands: ReturnType<typeof createNativeBoardOperations> } | null>(null);
    useEffect(() => {
        const camera = createNativeCameraOperations({ runtime, lease, current, signal, minimapVisible, setMinimapVisible });
        const actions = createNativeBoardActions({ lease, capabilities, camera, shortcutsAvailable, openShortcuts, openCommandPalette, print: runPrint, exportPdf: runExportPdf });
        const labels = localizeBoardChrome((key, values) => translateBoard(language.getSnapshot().table, key, values));
        const commands = createNativeBoardOperations({ runtime, lease, current, canWrite,
            frameName: () => 'Frame', flatten: capabilities.flatten, editLink: link.editLink, actions,
            keptLockedNotice: count => translateBoard(language.getSnapshot().table, 'notice.keptLocked', { count }),
            label: labels.commandLabel, shortcut: id => nativeCommandShortcut(id, mac), actionLabel: labels.actionLabel,
            actionShortcut: id => nativeActionShortcut(id, mac), notice: setNotice, pasteLanding: () => clipboard.landing(), onError: report });
        const value = { camera, commands }; setOwned(value);
        return () => setOwned(previous => previous === value ? null : previous);
    }, [runtime, lease, current, signal, minimapVisible, setMinimapVisible, capabilities, shortcutsAvailable, openShortcuts, openCommandPalette,
        language, canWrite, link, mac, setNotice, report, runPrint, runExportPdf, clipboard]);
    useLayoutEffect(() => {
        if (!owned) return;
        const { commands, camera } = owned;
        const extra = createNativeEditingKeyboard({ runtime, lease, commands, camera, preferences: clipboard.preferences,
            openShortcuts: () => { if (!shortcutRef.current) return false; shortcutRef.current(); return true; },
            openCommandPalette,
            // I inverts the one picture selected, and does nothing when no picture is (it is never a page command).
            invertPicture: () => {
                const picture = clipboard.media.selection(canWrite());
                if (!picture || picture.kind !== 'picture' || picture.blocked !== null || picture.video) return false;
                try { clipboard.media.invert(picture.id); } catch (error) { report(error); }
                return true;
            },
            // Enter on the one picture selected opens the same crop editor as the picture's menu.
            cropPicture: () => {
                const picture = clipboard.media.selection(canWrite());
                if (!picture || picture.kind !== 'picture' || picture.blocked !== null || picture.video || !clipboard.media.cropSource(picture.id)) return false;
                openCrop(picture.id); return true;
            },
            current, canWrite, report });
        const keys = createNativeKeyCommands(commands, (id, event) => extra(id, event)); commandRef.current = keys.run;
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
        dialogs.requestText, openCrop, linksRef, openCommandPalette]);
    const registerShortcuts = useCallback((open: () => void) => {
        shortcutRef.current = open; refreshServices(value => value + 1);
        return () => { if (shortcutRef.current === open) shortcutRef.current = null; };
    }, []);
    const registerCommandPalette = useCallback((open: () => void) => {
        paletteRef.current = open;
        return () => { if (paletteRef.current === open) paletteRef.current = null; };
    }, [paletteRef]);
    const paletteSelection = useCallback(() => contextMenuRef.current?.selectionEntries() ?? [], [contextMenuRef]);
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
            minimapVisible={context.minimapOpen} confirm={dialogs.confirm} canWrite={canWrite} registerShortcuts={registerShortcuts}
            registerCommandPalette={registerCommandPalette} paletteSelection={paletteSelection} onReady={handleChromeReady} onStyles={onStyles}
            notebook={runtime.session.doc.kind !== 'whiteboard' ? { inverted, setInverted, thumbnailsOpen: thumbnails, setThumbnailsOpen: setThumbnails } : undefined} />
            <NativePictureToolbar lease={lease} media={clipboard.media} store={clipboard.crop} t={translate} isVisible={props.isVisible} writable={canWrite}
                requestText={dialogs.requestText} onError={report} notice={setNotice} />
            <NativePictureCrop lease={lease} store={clipboard.crop} media={clipboard.media} t={translate} isVisible={props.isVisible} onError={report} /></NativeChromeAttachment>;
    }, [runtime, lease, language, clipboard, current, mac, props.isVisible, adapter, canWrite, report, toolStateFor, owned, dialogs.confirm, registerShortcuts, registerCommandPalette, paletteSelection, onStyles, handleChromeReady, inverted, setInverted, thumbnails, bindMinimap,
        translate, dialogs.requestText, setNotice]);
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
        } catch (error) { setAdmissionFailed(true); report(error); }
    }, [props.isVisible, signal, current, attached, chromeReady, owned, embedPort, lease, styleRef, commandRef,
        contextMenuRef, canMutateView, host, identity, adapter, servicesEpoch, report]);

    if (!owned) return <>{dialogs.dialogs}<div role="status">Preparing board commands…</div></>;
    const editable = attached && chromeReady && !!embedPort && !adapter.board.isReadOnly && host.canWrite(identity);
    // A writable source is sealed read-only only until the services above connect and the effect admits it; saying "read-only"
    // meanwhile flashed on every board load (measured: 34 ms, under "Loading drawing…"). A refused admission says so.
    const admitting = !editable && !admissionFailed && host.canWriteSource(identity);
    return <>{dialogs.dialogs}{renderView({ lease, chrome: editingChrome, inverted, setInverted, notices,
            editable, admitting, canMutate: lease.canMutateView })}</>;
}

function NativeChromeAttachment({ context, bind, children }: { readonly context: NativeEditingChromeContext;
    readonly bind: (context: NativeEditingChromeContext) => () => void; readonly children: ReactNode }) {
    const { minimapOpen, setMinimapOpen } = context;
    useLayoutEffect(() => bind({ ...context, minimapOpen, setMinimapOpen }), [bind, context, minimapOpen, setMinimapOpen]);
    return children;
}
