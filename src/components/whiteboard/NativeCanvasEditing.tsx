import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { getBoardPreferences } from '../../utils/boardPreferences';
import { getContextMenu } from '../../utils/contextMenu';
import { translateBoard } from '../../whiteboard/chrome/language';
import { localizeBoardChrome } from './chrome/localize';
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
import { createNativeBoardOperations } from './nativeBoardOperations';
import { createNativeCameraOperations } from './nativeCameraOperations';
import { createNativeKeyCommands, nativeActionShortcut, nativeCommandShortcut } from './nativeCommandSource';
import { createNativeEditingKeyboard } from './nativeEditingKeyboard';
import type { NativeEditingCapabilities, NativeEditingCapabilityFactory } from './nativeEditingCapabilities';
import { createNativeLinkOperations } from './nativeLinkOperations';
import type { createNativeViewLease, NativeViewLease } from './nativeViewLease';
import { documentClipboard, type NativeClipboardService } from './useNativeClipboard';
import { useNativeBoardDialogs } from './useNativeBoardDialogs';
import { useNativeBoardLanguage } from './useNativeBoardLanguage';

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
    readonly setNotice: (value: string) => void;
    readonly editable: boolean;
    readonly canMutate: () => boolean;
}

/** This mounts actual editing input and chrome against the acquired document. The temporary
 * admission seal remains until the complete per-embed presentation service is connected. */
export function NativeCanvasEditing({ props, board, adapter, factory, createLease, renderView, onError, onUnavailable }: {
    readonly props: NativeEditingViewProps;
    readonly board: ComposedBoardSession;
    readonly adapter: HostedBoardAdapter<BoardSessionPort>;
    readonly factory: NativeEditingCapabilityFactory;
    readonly createLease: (editing: NativeEditingViewOptions, signal: AbortSignal, notice: (message: string) => void) => Promise<NativeViewLease>;
    readonly renderView: (context: NativeEditingRenderContext) => ReactNode;
    readonly onError: (error: unknown) => void;
    readonly onUnavailable: (error: unknown) => void;
}) {
    const runtime = getBoardRuntime(board);
    if (!runtime || runtime.session !== board) throw new Error('Native editor requires the acquired board runtime');
    const { identity, nativeCanvasHost: host } = props;
    const current = useCallback(() => host.isCurrent(identity), [host, identity]);
    const language = useNativeBoardLanguage(onUnavailable);
    const dialogs = useNativeBoardDialogs({ documentId: identity.documentId, session: identity.session, isVisible: props.isVisible, currentOwner: current });
    const [notice, setNotice] = useState<string | null>(null), [inverted, setInverted] = useState(false);
    const [lease, setLease] = useState<NativeViewLease | null>(null), [clipboard, setClipboard] = useState<NativeClipboardService | null>(null);
    const [capabilities, setCapabilities] = useState<NativeEditingCapabilities | null>(null), [attached, setAttached] = useState(false);
    const commandRef = useRef<((id: string, event: KeyboardEvent) => boolean) | null>(null), linksRef = useRef<Links | null>(null);
    const [lifetime, setLifetime] = useState<AbortController | null>(null);
    const viewRef = useRef<NativeViewLease | null>(null), chromeMountedRef = useRef(false);
    // Populated only when the real presentation port AND semantic per-node Load service are attached.
    const embedPortRef = useRef<EmbedPresentationPort | null>(null);
    const [embedPort] = useState<EmbedPresentationPort | null>(null);
    const canMutateView = useCallback(() => !!viewRef.current?.editing?.isAttached() && chromeMountedRef.current && !!embedPortRef.current, []);
    const onChromeReady = useCallback((ready: boolean) => { chromeMountedRef.current = ready; }, []);
    const report = useCallback((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : String(error));
    }, []);
    useEffect(() => {
        if (!props.isVisible) return;
        const controller = new AbortController(); setLifetime(controller);
        let live = true, view: NativeViewLease | undefined, owned: NativeEditingCapabilities | undefined;
        void (async () => {
        try {
            const service = documentClipboard(runtime, host, identity);
            const editing: NativeEditingViewOptions = { clipboard: service, canMutate: canMutateView, onAttachment(value) { if (live) setAttached(value); },
                    commands: { run(id, event) { const run = commandRef.current; if (!run) throw new Error('Board commands are not attached'); return run(id, event); } },
                    ui: { mac: /Mac|iPhone|iPad/.test(navigator.platform), shortcutsEnabled: () => getBoardPreferences().areKeyboardShortcutsEnabled,
                        modalOpen: () => !!getContextMenu() || !!document.querySelector('[aria-modal="true"]'),
                        isDirectPen: event => event.pointerType === 'pen' && navigator.maxTouchPoints > 0,
                        ownsWheel: event => !event.composedPath().some(target => target instanceof Element &&
                            target.matches('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]')),
                        error: report, penModeChanged(enabled) { viewRef.current?.editing?.announce(enabled ? 'Pen mode enabled.' : 'Pen mode disabled.'); },
                        text: { openLink(url) { const target = linksRef.current; if (!target) throw new Error('Link actions are unavailable'); target.openLink(url); },
                            command(name) { const target = linksRef.current; if (name !== 'link' || !target) throw new Error('Text command is unavailable'); void target.editText().catch(report); },
                            touchHandles(show) { viewRef.current?.editing?.announce(show ? 'Text selection handles shown.' : 'Text selection handles hidden.'); },
                            reducedMotion: () => getBoardPreferences().animationSpeed === 0,
                            dynamicTextSize: () => getBoardPreferences().isDynamicResizeMode } } };
            view = await createLease(editing, controller.signal, setNotice);
            if (!live || controller.signal.aborted || !current()) { view.dispose(); return; }
            viewRef.current = view; setClipboard(service); setLease(view);
            const acquired = view;
            void factory({ runtime, lease: acquired, host, identity, clipboard: service, signal: controller.signal,
                current, canWrite: () => canMutateView() && host.canWrite(identity), requestText: dialogs.requestText, notice: setNotice }).then(value => {
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
        canMutateView={canMutateView} onChromeReady={onChromeReady} embedPort={embedPort} renderView={renderView} />;
}

function ConnectedEditor({ props, lease, adapter, clipboard, capabilities, language, signal, dialogs, current, report,
    notice, setNotice, inverted, setInverted, attached, commandRef, linksRef, canMutateView, onChromeReady, embedPort, renderView }: {
    readonly props: NativeEditingViewProps; readonly lease: NativeViewLease; readonly adapter: HostedBoardAdapter<BoardSessionPort>;
    readonly clipboard: NativeClipboardService; readonly capabilities: NativeEditingCapabilities;
    readonly language: NonNullable<ReturnType<typeof useNativeBoardLanguage>>; readonly signal: AbortSignal;
    readonly dialogs: ReturnType<typeof useNativeBoardDialogs>; readonly current: () => boolean; readonly report: (error: unknown) => void;
    readonly notice: string | null; readonly setNotice: (message: string) => void; readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void; readonly attached: boolean;
    readonly commandRef: RefObject<((id: string, event: KeyboardEvent) => boolean) | null>; readonly linksRef: RefObject<Links | null>;
    readonly renderView: (context: NativeEditingRenderContext) => ReactNode;
    readonly canMutateView: () => boolean; readonly onChromeReady: (ready: boolean) => void;
    readonly embedPort: EmbedPresentationPort | null;
}) {
    const runtime = lease.runtime, host = props.nativeCanvasHost, identity = props.identity;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const shortcutRef = useRef<(() => void) | null>(null), styleRef = useRef<Styles | null>(null);
    const [chromeReady, setChromeReady] = useState(false), [thumbnails, setThumbnails] = useState(false);
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
    const link = useMemo(() => createNativeLinkOperations({ runtime, lease, current, canWrite,
        requestText: dialogs.requestText, notice: setNotice }), [runtime, lease, current, canWrite, dialogs.requestText, setNotice]);
    useLayoutEffect(() => { linksRef.current = link; return () => { if (linksRef.current === link) linksRef.current = null; }; }, [linksRef, link]);
    const [owned, setOwned] = useState<{ camera: ReturnType<typeof createNativeCameraOperations>;
        commands: ReturnType<typeof createNativeBoardOperations> } | null>(null);
    useEffect(() => {
        const camera = createNativeCameraOperations({ runtime, lease, current, signal, minimapVisible, setMinimapVisible });
        const actions = createNativeBoardActions({ lease, capabilities, camera, shortcutsAvailable, openShortcuts });
        const labels = localizeBoardChrome((key, values) => translateBoard(language.getSnapshot().table, key, values));
        const commands = createNativeBoardOperations({ runtime, lease, current, canWrite,
            frameName: () => 'Frame', flatten: capabilities.flatten, editLink: link.editLink, actions,
            label: labels.commandLabel, shortcut: id => nativeCommandShortcut(id, mac), actionLabel: labels.actionLabel,
            actionShortcut: id => nativeActionShortcut(id, mac), notice: setNotice, onError: report });
        const value = { camera, commands }; setOwned(value);
        return () => setOwned(previous => previous === value ? null : previous);
    }, [runtime, lease, current, signal, minimapVisible, setMinimapVisible, capabilities, shortcutsAvailable, openShortcuts,
        language, canWrite, link, mac, setNotice, report]);
    useLayoutEffect(() => {
        if (!owned) return;
        const { commands, camera } = owned;
        const extra = createNativeEditingKeyboard({ runtime, lease, commands, camera, preferences: clipboard.preferences,
            styles: () => styleRef.current, openShortcuts: () => { if (!shortcutRef.current) return false; shortcutRef.current(); return true; },
            current, canWrite, report });
        const keys = createNativeKeyCommands(commands, id => extra(id)); commandRef.current = keys.run;
        return () => { if (commandRef.current === keys.run) commandRef.current = null; };
    }, [commandRef, runtime, lease, owned, clipboard, current, canWrite, report]);
    const registerShortcuts = useCallback((open: () => void) => { shortcutRef.current = open; return () => { if (shortcutRef.current === open) shortcutRef.current = null; }; }, []);
    const onStyles = useCallback((value: Styles | null) => { styleRef.current = value; }, []);
    const handleChromeReady = useCallback((ready: boolean) => { onChromeReady(ready); setChromeReady(ready); }, [onChromeReady]);
    const toolStateFor = useCallback((id: string, figure?: string): CommandState => {
        if (adapter.board.isReadOnly || !canWrite()) return { enabled: false, reason: adapter.board.readOnlyReason ?? 'Board is read-only' };
        if (!runtime.tools.getRegistration(id) || (id === 'figure' && figure && !FIGURE_SHAPES.includes(figure as FigureShape))) return { enabled: false, reason: 'Tool is unavailable' };
        return { enabled: true };
    }, [adapter, canWrite, runtime]);
    const editingChrome = useCallback((context: NativeEditingChromeContext) => {
        if (!owned) throw new Error('Board commands are not attached');
        const { commands } = owned;
        return <NativeChromeAttachment context={context} bind={bindMinimap}><NativeBoardChromeHost runtime={runtime} engine={lease.engine} lease={lease} language={language} preferences={clipboard.preferences}
            currentOwner={current} mac={mac} isVisible={props.isVisible}
            readOnly={adapter.board.isReadOnly || !canWrite()} readOnlyReason={adapter.board.readOnlyReason ?? 'Board editing services are not ready'} reportError={report}
            toolStateFor={toolStateFor} commands={commands} actionShortcut={commands.actionShortcut} actionState={commands.actionState}
            runAction={commands.runAction} openMedia={() => { void commands.runAction('uploadMedia'); }} zoom={context.zoom}
            minimapVisible={context.minimapOpen} confirm={dialogs.confirm} registerShortcuts={registerShortcuts} onReady={handleChromeReady} onStyles={onStyles}
            notebook={runtime.session.doc.kind === 'notebook' ? { inverted, setInverted, thumbnailsOpen: thumbnails, setThumbnailsOpen: setThumbnails } : undefined} /></NativeChromeAttachment>;
    }, [runtime, lease, language, clipboard, current, mac, props.isVisible, adapter, canWrite, report, toolStateFor, owned, dialogs.confirm, registerShortcuts, onStyles, handleChromeReady, inverted, setInverted, thumbnails, bindMinimap]);
    if (!owned) return <>{dialogs.dialogs}<div role="status">Preparing board commands…</div></>;
    return <>{dialogs.dialogs}{attached && chromeReady && <span role="status">Canvas editing services are attached; document remains read-only until all source services are ready.</span>}
        {renderView({ lease, chrome: editingChrome, inverted, setInverted, notice, setNotice,
            editable: attached && chromeReady && !!embedPort && !adapter.board.isReadOnly && host.canWrite(identity),
            canMutate: lease.canMutateView })}</>;
}

function NativeChromeAttachment({ context, bind, children }: { readonly context: NativeEditingChromeContext;
    readonly bind: (context: NativeEditingChromeContext) => () => void; readonly children: ReactNode }) {
    const { minimapOpen, setMinimapOpen } = context;
    useLayoutEffect(() => bind({ ...context, minimapOpen, setMinimapOpen }), [bind, context, minimapOpen, setMinimapOpen]);
    return children;
}
