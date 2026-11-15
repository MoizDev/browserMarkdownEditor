import type { BoardInputHostOptions } from '../../whiteboard/viewer/inputHost';
import { createBoardInputHost } from '../../whiteboard/viewer/inputHost';
import { createBoardAccessibilityDom } from '../../whiteboard/viewer/accessibilityDom';
import { createBoardKeyboardNavigation } from '../../whiteboard/viewer/keyboardNavigation';
import { createBoardToolServices, type BoardToolServicesOptions } from '../../whiteboard/viewer/toolServices';
import { addBoardDictionaryWord, getBoardDictionary, subscribeBoardDictionary } from '../../utils/boardDictionary';
import { closeContextMenu, getContextMenu, openContextMenu, type ContextMenuRequest } from '../../utils/contextMenu';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { createEmbedPresentationPort } from '../../platform/render/embedPresentation';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import { createNativeEmbedController, type NativeEmbedController } from '../../whiteboard/host/nativeEmbeds';
import { createNativeEmbedPresentationProducer, type NativeEmbedPresentationProducer } from '../../whiteboard/host/embedPresentationFacts';
import type { NativeClipboardBinding, NativeClipboardService } from './useNativeClipboard';
import { createNativeImportAdapter } from './nativeImportAdapter';
import { createNativeTextClipboard } from './nativeTextClipboard';

const spelling: BoardToolServicesOptions['spelling'] = {
    words: getBoardDictionary, subscribe: subscribeBoardDictionary,
    add(word) {
        const status = addBoardDictionaryWord(word);
        if (status === 'full') throw new Error('The board dictionary is full.');
        if (status === 'invalid') throw new Error('This word cannot be added to the board dictionary.');
        if (status === 'failed') throw new Error('Could not save the board dictionary.');
    },
};

export interface NativeEmbedInfrastructure {
    readonly port: EmbedPresentationPort;
    readonly controller: NativeEmbedController;
    readonly producer: NativeEmbedPresentationProducer;
}

export type NativeEditingToolOptions = Omit<BoardToolServicesOptions, 'surface' | 'overlay' | 'inputFrames' | 'mappings' | 'sampleToSurface' | 'clientToSurface' | 'imports' | 'spelling' | 'ui'> & {
    readonly ui: Omit<BoardToolServicesOptions['ui'], 'text' | 'keyboardNavigation'> & {
        readonly text: Omit<BoardToolServicesOptions['ui']['text'], 'spellingMenu' | 'selectionChanged' | 'menu'>;
    };
};

/** One view's tools borrow the already-attached engine, camera, images and session.
 * DOM-bound controllers are recreated only with their real surface and released on detach. */
export function createNativeEditingLease(options: Omit<BoardInputHostOptions, 'services' | 'overlays' | 'mode' | 'a11y'> & {
    readonly toolOptions: NativeEditingToolOptions;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly clipboard: NativeClipboardService;
    onEmbedInfrastructure(value: NativeEmbedInfrastructure | null): void;
    bindClipboard(surface: HTMLElement): NativeClipboardBinding;
}) {
    if (options.toolOptions.runtime !== options.runtime || options.toolOptions.engine !== options.engine ||
        options.toolOptions.camera !== options.camera) throw new Error('Editing must use the attached board view');
    let tools: ReturnType<typeof createBoardToolServices> | null = null, spellingMenu: ContextMenuRequest | null = null;
    let textMenu: ContextMenuRequest | null = null;
    let binding: NativeClipboardBinding | null = null, textClipboard: ReturnType<typeof createNativeTextClipboard> | null = null;
    let importer: ReturnType<typeof createNativeImportAdapter> | null = null;
    let accessible: ReturnType<typeof createBoardAccessibilityDom> | null = null;
    let embed: NativeEmbedInfrastructure | null = null;
    let toolSurface: HTMLElement | null = null, toolOverlay: HTMLElement | null = null;
    const closeSpelling = () => { if (spellingMenu && getContextMenu() === spellingMenu) closeContextMenu(); spellingMenu = null; };
    const closeTextMenu = () => { if (textMenu && getContextMenu() === textMenu) closeContextMenu(); textMenu = null; };
    const disposeTools = () => {
        closeSpelling(); closeTextMenu();
        const text = textClipboard, old = tools, clip = binding, media = importer, a11y = accessible, previousEmbed = embed;
        textClipboard = null; tools = null; binding = null; importer = null; accessible = null; embed = null;
        toolSurface = null; toolOverlay = null;
        if (previousEmbed) {
            options.onEmbedInfrastructure(null);
            previousEmbed.producer.dispose();
            options.engine.connectEmbeds(null);
            void previousEmbed.controller.dispose().finally(() => previousEmbed.port.dispose()).catch(options.onError);
        }
        try { text?.dispose(); } finally { try { old?.dispose(); } finally {
            try { media?.dispose(); } finally { try { a11y?.dispose(); } finally { clip?.detach(); } }
        } }
    };
    const input = createBoardInputHost({ ...options, mode: 'edit',
        presented: (...args) => embed?.producer.presented(...args),
        a11y: {
            toolState(snapshot) { accessible?.a11y.toolState(snapshot); },
            bindKeyboardCursor(activate) {
                if (!accessible?.a11y.bindKeyboardCursor) throw new Error('Board accessibility is unavailable');
                return accessible.a11y.bindKeyboardCursor(activate);
            },
            keyboardCursor(point, gesture) { accessible?.a11y.keyboardCursor?.(point, gesture); },
        },
        services(surface, overlay) {
            // Layer attachment briefly pauses platform input. Recreating the embed
            // layer on that pause caused an attach/remove/render loop in the real app.
            // These services belong to the DOM view, not each enable/disable pulse.
            if (tools && toolSurface === surface && toolOverlay === overlay) return tools.services;
            disposeTools();
            toolSurface = surface; toolOverlay = overlay;
            binding = options.bindClipboard(surface);
            try {
                const port = createEmbedPresentationPort({ overlay, onError: options.onError });
                try {
                    const controller = createNativeEmbedController({ runtime: options.runtime, token: options.token, presentation: port,
                        manifest: options.host.embeds.manifest, containment: options.host.embeds.create, environment: { appOrigin: location.origin },
                        current: () => options.current(options.token), visible: options.visible, onError: options.onError });
                    const producer = createNativeEmbedPresentationProducer({ port, images: options.toolOptions.images,
                        memory: options.clipboard.memory, onError: options.onError });
                    embed = { port, controller, producer };
                    options.engine.connectEmbeds(port);
                    options.onEmbedInfrastructure(embed);
                } catch (error) { void port.dispose().catch(options.onError); throw error; }
                accessible = createBoardAccessibilityDom({ runtime: options.runtime, engine: options.engine, surface, overlay,
                    current: () => options.current(options.token), visible: options.visible,
                    schedule: callback => input.schedule(callback), reveal: id => { if (id) options.engine.focusNode(id); },
                    contextMenu: options.toolOptions.ui.contextMenu, error: options.onError });
                importer = createNativeImportAdapter(binding, options.runtime, () => options.current(options.token) &&
                    options.toolOptions.editable() && options.host.canWrite(options.identity), options.onError);
                const keyboardNavigation = createBoardKeyboardNavigation({ runtime: options.runtime, camera: options.camera,
                    viewport: options.viewport, paged: options.paged, current: () => options.current(options.token) && options.visible(),
                    editable: options.toolOptions.editable, nudge: (direction, coarse) => tools?.actualsubcontrollers.select.nudge(direction, coarse) ?? false,
                    cancelMotion: () => options.toolOptions.platform().cancelMotion(), cancelReveal: () => options.engine.cancelReveal(),
                    changed: options.toolOptions.interaction.cameraChanged, error: options.onError });
                tools = createBoardToolServices({ ...options.toolOptions, spelling, surface, overlay, imports: importer.imports,
                    ui: { ...options.toolOptions.ui, keyboardNavigation,
                        text: { ...options.toolOptions.ui.text,
                            menu(x, y) {
                                const editor = tools?.actualsubcontrollers.text, selected = editor?.clipboardSelection(), link = editor?.linkContext();
                                const context = editor?.clipboardContext();
                                const reason = 'Select text first.', disabled = !selected,
                                    readOnly = options.runtime.session.isReadOnly || !options.toolOptions.editable() || !options.host.canWrite(options.identity);
                                const stillCurrent = () => {
                                    const now = editor?.clipboardContext();
                                    return !!context && !!now && options.current(options.token) && now.node === context.node && now.revision === context.revision
                                        && now.selection.anchor === context.selection.anchor && now.selection.focus === context.selection.focus;
                                };
                                const guarded = (run: () => void) => () => { if (stillCurrent()) run(); };
                                closeTextMenu();
                                const request: ContextMenuRequest = { x, y, label: 'Text', opener: document.activeElement instanceof HTMLElement ? document.activeElement : surface,
                                    entries: [
                                        { kind: 'command', id: 'text-copy', label: 'Copy', disabled, ...(disabled ? { reason } : {}),
                                            run: guarded(() => { void textClipboard?.copyMenu(); }) },
                                        { kind: 'command', id: 'text-cut', label: 'Cut', disabled: disabled || readOnly,
                                            ...(disabled || readOnly ? { reason: readOnly ? 'Board is read-only.' : reason } : {}),
                                            run: guarded(() => { void textClipboard?.copyMenu(true); }) },
                                        { kind: 'command', id: 'text-paste', label: 'Paste', disabled: readOnly || !context,
                                            ...(readOnly ? { reason: 'Board is read-only.' } : {}),
                                            run: guarded(() => { void textClipboard?.pasteSystem('paste'); }) },
                                        { kind: 'command', id: 'text-paste-plain', label: 'Paste as plain text', disabled: readOnly || !context,
                                            ...(readOnly ? { reason: 'Board is read-only.' } : {}),
                                            run: guarded(() => { void textClipboard?.pasteSystem('paste-plain'); }) },
                                        { kind: 'command', id: 'text-select-all', label: 'Select all', disabled: !context, run: guarded(() => { editor?.selectAll(); }) },
                                        { kind: 'separator', id: 'text-format' },
                                        ...(['bold', 'italic', 'underline', 'strike', 'code', 'highlight'] as const).map(name => ({
                                            kind: 'command' as const, id: `text-${name}`, label: name[0].toUpperCase() + name.slice(1), disabled: readOnly || !context,
                                            ...(readOnly ? { reason: 'Board is read-only.' } : {}), run: guarded(() => { editor?.command(name); }) })),
                                        { kind: 'command', id: 'text-link', label: link?.href ? 'Edit link' : 'Add link',
                                            disabled: readOnly || !link || (!selected && !link.href),
                                            ...(readOnly || !link || (!selected && !link.href) ? { reason: readOnly ? 'Board is read-only.' : reason } : {}),
                                            run: guarded(() => { if (link) options.toolOptions.ui.text.command('link', link.selection); }) },
                                    ], onClose() { if (textMenu === request) textMenu = null; } };
                                textMenu = request; openContextMenu(request);
                            },
                            selectionChanged(node) { textClipboard?.setActive(node !== null); },
                            command(name, selection) {
                                if (name === 'paste-inverted' || name === 'paste-plain' || name === 'paste-plain-inverted') {
                                    void textClipboard?.pasteSystem(name); return;
                                }
                                options.toolOptions.ui.text.command(name, selection);
                            },
                            spellingMenu(x, y, rows) {
                        closeSpelling();
                        if (!rows) return;
                        const request: ContextMenuRequest = { x, y, label: 'Spelling', opener: surface,
                            entries: [...rows.suggestions.map((word, index) => ({ kind: 'command' as const, id: `suggestion-${index}`,
                                label: word, run: () => { try { rows.choose(word); } catch (error) { options.onError(error); } } })),
                            { kind: 'command', id: 'add-word', label: 'Add to dictionary', disabled: !rows.canAdd,
                                run: () => { try { rows.add(); } catch (error) { options.onError(error); } } }],
                            onClose() { if (spellingMenu === request) spellingMenu = null; } };
                        spellingMenu = request; openContextMenu(request);
                    } } },
                    inputFrames: input, mappings: input.mappings,
                    sampleToSurface: input.sampleToSurface, clientToSurface: input.clientToSurface });
                textClipboard = createNativeTextClipboard({ surface, editor: tools.actualsubcontrollers.text,
                    runtime: options.runtime, host: options.host, identity: options.identity, clipboard: options.clipboard,
                    binding, canWriteView: options.toolOptions.editable, onError: options.onError });
                return tools.services;
            } catch (error) { disposeTools(); throw error; }
        },
        overlays: {
            write(frame) { tools?.writeOverlays(frame); },
            finishComposition() { tools?.finishComposition(); },
            captureText: () => tools?.captureText(),
            restoreText: value => tools?.restoreText(value),
            beforeHistoryReplay: (step, direction) => tools?.beforeHistoryReplay(step, direction) ?? true,
            dispose: disposeTools,
        },
    });
    return {
        ...input,
        onPresentation(presentation: Parameters<typeof input.onPresentation>[0]) {
            input.onPresentation(presentation);
            embed?.producer.onPresentation(presentation);
        },
        getTools: () => tools,
        getBinding: () => binding,
        getClipboard: () => textClipboard,
        getImporter: () => importer,
        announce: (message: string) => accessible?.announce(message) ?? false,
        repeatAnnouncement: () => accessible?.repeat() ?? false,
        setInputEnabled(enabled: boolean) {
            input.setInputEnabled(enabled);
            if (!options.visible()) disposeTools();
        },
        cancelViewWork(reason: string) {
            input.cancelViewWork(reason);
            // A layer-set seal cancels contacts, not the DOM view that owns the
            // very layers being installed. Actual detach/hide/source retirement
            // still drops providers and every per-view controller.
            if (reason === 'platform-detach' || !options.visible() || !options.current(options.token)) disposeTools();
        },
        attachInput(surface: HTMLElement, overlay: HTMLElement) {
            const detach = input.attachInput(surface, overlay);
            if (!input.isAttached()) disposeTools();
            return () => { try { detach(); } finally { disposeTools(); } };
        },
    };
}
