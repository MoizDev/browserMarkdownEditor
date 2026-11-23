import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { ContextMenuCommand, ContextMenuEntry } from '../../../utils/contextMenu';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences } from '../../../utils/boardPreferences';
import type { BoardCommand, BoardCommandSource, CommandState } from './boardCommands';
import { ConnectedBoardChrome, type ToolStateView } from './ConnectedBoardChrome';
import type { StylePanelProps } from './StylePanel';
import type { DebugOverlayProps } from './DebugOverlay';
import { getBoardDebugStats, subscribeBoardDebugStats } from '../debugStats';
import { boardLanguageMenu, type LanguageOption } from './languageMenu';
import { localizeBoardChrome, localizeShortcutGroups, type BoardTranslate } from './localize';
import { mainMenuEntries, type MainAction, type MainMenuSource } from './mainMenu';
import { preferenceEntries, type LocalPreferencesView } from './preferencesMenu';
import { ShortcutsDialog, type ShortcutGroup } from './ShortcutsDialog';
import { boardThemeMenu } from './themeMenu';
import { setEnhancedBoardTooltips } from '../../../utils/tooltip';
import { CommandPalette } from './CommandPalette';
import { rememberRecent, type PaletteGroup } from './commandPaletteModel';
import { paletteGroups, type PaletteSheetSource, type PaletteStyleCommands, type PaletteToolSource } from './commandPaletteGroups';
import { toolChoices } from './toolChoices';
import { arrangeSubmenus } from './boardCommands';

/** The sheet structure the palette lists and changes: the board's own sheet controls (useNativeSheetControls). */
export interface PaletteSheetControls {
    snapshot(): { readonly sheets: readonly { readonly id: string; readonly name: string }[]; readonly current: string; readonly canCreate: boolean };
    selectSheet(id: string): void;
    createSheet(): unknown;
    duplicateSheet(id: string): unknown;
}

/** Values come from the owning session and viewer; the chrome does not invent capability state. */
export interface SessionBoardChromeProps {
    readonly kind: 'whiteboard' | 'notebook' | 'pdf-ink';
    readonly isVisible: boolean;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly translate: BoardTranslate;
    readonly languages: readonly LanguageOption[];
    readonly selectLanguage: (locale: string) => Promise<void>;
    readonly reportError: (error: unknown) => void;
    readonly toolState: ToolStateView;
    readonly openMedia: () => void;
    readonly toolShortcut: (id: string, figure?: string) => string | undefined;
    readonly toolStateFor: (id: string, figure?: string) => CommandState;
    readonly commands: Omit<BoardCommandSource, 'label'>;
    readonly actionShortcut: (id: MainAction) => string | undefined;
    readonly actionState: (id: MainAction) => CommandState;
    readonly runAction: (id: MainAction) => void | Promise<void>;
    readonly shortcuts: readonly ShortcutGroup[];
    readonly registerShortcuts?: (open: () => void) => () => void;
    /** The keyboard's way to open the command palette: the chrome hands back its open function while it is mounted. */
    readonly registerCommandPalette?: (open: () => void) => () => void;
    /** The selection-scoped rows the palette lists first, read when it opens. */
    readonly paletteSelection?: () => readonly ContextMenuEntry[];
    readonly paletteStyles?: PaletteStyleCommands;
    readonly paletteSheets?: PaletteSheetControls;
    readonly localPreferences: LocalPreferencesView;
    readonly sheetName: string;
    readonly openSheets: (anchor: HTMLButtonElement) => void;
    readonly readOnly: boolean;
    readonly readOnlyReason: string;
    readonly zoom: number;
    readonly minimapVisible: boolean;
    /** The style panel's model and commands, from the attached board session. */
    readonly stylePanel?: Pick<StylePanelProps, 'snapshot' | 'commands'>;
    /** The paged host's paper controls, rendered inside the chrome column under the header. */
    readonly pageControls?: ReactNode;
}

interface OpenPalette { readonly groups: readonly PaletteGroup[]; readonly returnFocus: HTMLElement | null }

export function SessionBoardChrome(props: SessionBoardChromeProps) {
    const global = useSyncExternalStore(subscribeBoardPreferences, getBoardPreferences, getBoardPreferences);
    useEffect(() => {
        setEnhancedBoardTooltips(global.enhancedA11yMode);
        return () => setEnhancedBoardTooltips(false);
    }, [global.enhancedA11yMode]);
    const debugStats = useSyncExternalStore(subscribeBoardDebugStats, getBoardDebugStats, getBoardDebugStats);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
    const [palette, setPalette] = useState<OpenPalette | null>(null);
    const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
    const { isVisible, registerShortcuts, registerCommandPalette } = props;
    useEffect(() => { if (!isVisible) { setShortcutsOpen(false); setPalette(null); } }, [isVisible]);
    // Focus mode clears dialogs, as tldraw's does (actions.tsx:1837-1846): the board goes to one dot, with nothing open over it.
    const focusMode = props.localPreferences.view.focusMode;
    useEffect(() => { if (focusMode) { setShortcutsOpen(false); setPalette(null); } }, [focusMode]);
    useEffect(() => {
        if (!isVisible) return;
        return registerShortcuts?.(() => {
            setReturnFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
            setShortcutsOpen(true);
        });
    }, [registerShortcuts, isVisible]);
    const labels = localizeBoardChrome(props.translate);
    const canRead = (id: BoardCommand) => id === 'copy' || id === 'selectAll' || id === 'copyAsPng'
        || id === 'copyAsSvg' || id === 'copyAsJson' || id === 'exportPng' || id === 'exportSvg' || id === 'exportJson';
    const commandState = (id: BoardCommand): CommandState => props.readOnly && !canRead(id)
        ? { enabled: false, reason: props.readOnlyReason } : props.commands.state(id);
    const commandSource: BoardCommandSource = {
        label: labels.commandLabel, shortcut: id => props.commands.shortcut(id), state: commandState,
        run: id => { if (commandState(id).enabled) return props.commands.run(id); },
    };
    const theme = boardThemeMenu(props.kind, global.colorScheme, labels.text('theme'), {
        dark: labels.text('dark'), light: labels.text('light'), system: labels.text('system'),
    }, colorScheme => updateBoardPreferences({ colorScheme }));
    const language = boardLanguageMenu(labels.text('language'), props.locale, props.languages,
        props.selectLanguage, props.reportError);
    const preferences = preferenceEntries({ local: props.localPreferences, label: labels.preferenceLabel, theme });
    const editAction = (id: MainAction) => id === 'uploadMedia' || id === 'insertEmbed' || id === 'unlockAll'
        || id === 'convertToBookmark' || id === 'convertToEmbed';
    const actionState = (id: MainAction): CommandState => {
        if (props.readOnly && editAction(id)) return { enabled: false, reason: props.readOnlyReason };
        // The shortcuts dialog and the palette are views of the board's commands, so they open on a read-only board too.
        return id === 'keyboardShortcuts' || id === 'commandPalette' ? { enabled: true } : props.actionState(id);
    };
    const focusedElement = (): HTMLElement | null => document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A header button keeps the keyboard after a menu closes, and then the board's shortcuts hear nothing: focus goes back to the board itself.
    const boardSurface = (anchor: HTMLElement): HTMLElement => anchor.closest<HTMLElement>('.board-viewer-host')?.querySelector<HTMLElement>('.board-interaction-root') ?? anchor;
    const runAction = (id: MainAction) => {
        if (!actionState(id).enabled) return;
        if (id === 'keyboardShortcuts') {
            setReturnFocus(focusedElement());
            setShortcutsOpen(true);
        } else if (id === 'commandPalette') {
            setPalette({ groups: buildPalette(), returnFocus: focusedElement() });
        } else return props.runAction(id);
    };
    const actions = { actionLabel: labels.actionLabel, actionShortcut: (id: MainAction) => props.actionShortcut(id),
        actionState, runAction };
    const menu: MainMenuSource = {
        ...commandSource, ...actions, sectionLabel: labels.mainSectionLabel, preferences, language,
        copyAsLabel: labels.contextSectionLabel('copyAs'), transparentLabel: labels.text('transparent'),
        transparent: props.localPreferences.view.transparent, debugMode: props.localPreferences.view.debugMode,
        toggleTransparent: () => props.localPreferences.setView('transparent', !props.localPreferences.view.transparent),
    };
    const toolSource = (): PaletteToolSource => {
        const active = props.toolState.getSnapshot().active;
        return { choices: toolChoices(labels.toolLabel, props.toolShortcut), current: { id: active.id, figure: active.variant },
            state: props.toolStateFor,
            select(id, figure) { if (id === 'media') props.openMedia(); else props.toolState.setTool(id, figure); } };
    };
    const sheetSource = (): PaletteSheetSource | null => {
        const controls = props.paletteSheets;
        if (!controls) return null;
        let snapshot: ReturnType<PaletteSheetControls['snapshot']>;
        try { snapshot = controls.snapshot(); } catch { return null; }
        return { sheets: snapshot.sheets, current: snapshot.current, canCreate: snapshot.canCreate && !props.readOnly,
            select: id => controls.selectSheet(id), create: () => { controls.createSheet(); }, duplicate: id => { controls.duplicateSheet(id); } };
    };
    // The palette's rows are read when it opens, from the same sources the menus use. The ref keeps the registered opener current.
    const buildPalette = (): readonly PaletteGroup[] => paletteGroups({
        translate: props.translate, sectionLabel: labels.mainSectionLabel, main: mainMenuEntries(menu), preferences,
        selection: props.paletteSelection?.() ?? [], arrange: arrangeSubmenus(commandSource, labels.contextSectionLabel), arrangeLabel: labels.contextSectionLabel('arrange'),
        styles: props.paletteStyles ?? null, sheets: sheetSource(), tools: toolSource(),
    });
    const buildRef = useRef(buildPalette);
    useLayoutEffect(() => { buildRef.current = buildPalette; });
    useEffect(() => {
        if (!isVisible) return;
        return registerCommandPalette?.(() => setPalette({ groups: buildRef.current(), returnFocus: focusedElement() }));
    }, [registerCommandPalette, isVisible]);
    const closePalette = useCallback(() => setPalette(null), []);
    const runPaletteRow = (key: string, command: ContextMenuCommand) => {
        updateBoardPreferences({ paletteRecents: rememberRecent(getBoardPreferences().paletteRecents, key, 20) });
        // The palette unmounts before its command runs, so focus is back on the board when the command opens something of its own.
        flushSync(() => setPalette(null));
        try {
            const result = command.run();
            if (result instanceof Promise) void result.catch(props.reportError);
        } catch (error) { props.reportError(error); }
    };
    // Debug mode's overlay shows the board's own diagnostics: the tool, the counts and the frame time are live (debugStats).
    const active = props.toolState.getSnapshot().active;
    const debugOverlay: DebugOverlayProps | undefined = props.localPreferences.view.debugMode ? {
        label: labels.text('debugOverlay'), locale: props.locale, direction: props.direction,
        toolLabel: labels.text('debugTool'), selectionLabel: labels.text('debugSelection'), sheetLabel: labels.text('debugSheet'),
        zoomLabel: labels.text('debugZoom'), frameTimeLabel: labels.text('debugFrameTime'), nodeCountLabel: labels.text('debugNodes'),
        visibleCountLabel: labels.text('debugVisibleNodes'), backendLabel: labels.text('debugBackend'),
        tool: active.id, toolState: active.variant ?? 'active', selectionCount: debugStats.selectionCount,
        sheet: props.sheetName, zoom: props.zoom, frameTimeMs: debugStats.frameTimeMs, nodeCount: debugStats.nodeCount,
        visibleCount: debugStats.visibleCount, backend: debugStats.backend, outlines: debugStats.outlines,
    } : undefined;
    if (!props.isVisible) return null;
    const paletteNode = palette ? <CommandPalette groups={palette.groups} readOnly={props.readOnly} recent={global.paletteRecents}
        label={labels.text('commandPalette')} placeholder={props.translate('palette.search')} emptyLabel={props.translate('palette.noResults')}
        recentLabel={props.translate('palette.recent')} backLabel={props.translate('palette.back')} locale={props.locale}
        direction={props.direction} returnFocus={palette.returnFocus} onRun={runPaletteRow} onClose={closePalette} /> : undefined;
    return <>
        <ConnectedBoardChrome toolState={props.toolState} openMedia={props.openMedia}
            locale={props.locale} direction={props.direction} commands={commandSource}
            menuLabel={labels.text('menu')} menuEntries={anchor => mainMenuEntries({ ...menu, runAction: id => {
                if (id === 'keyboardShortcuts') { setReturnFocus(anchor); setShortcutsOpen(true); }
                else if (id === 'commandPalette') setPalette({ groups: buildRef.current(), returnFocus: boardSurface(anchor) });
                else return runAction(id);
            } })} sheetName={props.kind === 'pdf-ink' ? labels.text('annotationSheets') : props.sheetName}
            openSheets={props.openSheets} actionsLabel={labels.text('actions')}
            toolLabel={labels.toolLabel} toolShortcut={props.toolShortcut} toolsLabel={labels.text('tools')}
            moreLabel={labels.text('more')} readOnly={props.readOnly} readOnlyReason={props.readOnlyReason}
            toolDisabledReason={choice => {
                const state = props.toolStateFor(choice.id, choice.figure);
                return state.enabled ? undefined : state.reason;
            }} focusMode={props.localPreferences.view.focusMode}
            focusModeLabel={labels.preferenceLabel('focusMode')} exitFocusMode={() => props.localPreferences.setView('focusMode', false)}
            toolLockLabel={labels.preferenceLabel('toolLock')}
            stylePanel={props.stylePanel ? { snapshot: { ...props.stylePanel.snapshot, disabled: props.readOnly || props.stylePanel.snapshot.disabled },
                commands: props.stylePanel.commands, toolLabel: labels.toolLabel, subheadings: global.enhancedA11yMode,
                history: id => { void commandSource.run(id); } } : undefined}
            debug={debugOverlay} pageControls={props.pageControls} palette={paletteNode}
            zoomControls={{ zoom: props.zoom, locale: props.locale, direction: props.direction,
                zoomLabel: labels.text('zoom'), minimapLabel: labels.text('minimap'),
                minimapVisible: props.minimapVisible, commands: actions }} />
        {shortcutsOpen && <ShortcutsDialog label={labels.text('keyboardShortcuts')} locale={props.locale}
            direction={props.direction} closeLabel={labels.text('close')}
            offNotice={global.areKeyboardShortcutsEnabled ? undefined : labels.text('keyboardShortcutsOff')}
            groups={localizeShortcutGroups(props.shortcuts, props.translate)} returnFocus={returnFocus} onClose={closeShortcuts} />}
    </>;
}
