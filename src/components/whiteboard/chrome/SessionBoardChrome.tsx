import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences } from '../../../utils/boardPreferences';
import type { BoardCommand, BoardCommandSource, CommandState } from './boardCommands';
import { ConnectedBoardChrome, type ToolStateView } from './ConnectedBoardChrome';
import type { ConnectedPenPanelProps } from './ConnectedPenPanel';
import type { DebugOverlayProps } from './DebugOverlay';
import { boardLanguageMenu, type LanguageOption } from './languageMenu';
import { localizeBoardChrome, localizeShortcutGroups, type BoardTranslate } from './localize';
import { mainMenuEntries, type MainAction, type MainMenuSource } from './mainMenu';
import { preferenceEntries, type LocalPreferencesView } from './preferencesMenu';
import { ShortcutsDialog, type ShortcutGroup } from './ShortcutsDialog';
import { boardThemeMenu } from './themeMenu';

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
    readonly localPreferences: LocalPreferencesView;
    readonly sheetName: string;
    readonly openSheets: (anchor: HTMLButtonElement) => void;
    readonly readOnly: boolean;
    readonly readOnlyReason: string;
    readonly zoom: number;
    readonly minimapVisible: boolean;
    readonly penPanel?: ConnectedPenPanelProps;
    readonly debug?: DebugOverlayProps;
}

export function SessionBoardChrome(props: SessionBoardChromeProps) {
    const global = useSyncExternalStore(subscribeBoardPreferences, getBoardPreferences, getBoardPreferences);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
    const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
    useEffect(() => { if (!props.isVisible) setShortcutsOpen(false); }, [props.isVisible]);
    useEffect(() => {
        if (!props.isVisible) return;
        return props.registerShortcuts?.(() => {
            setReturnFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
            setShortcutsOpen(true);
        });
    }, [props.registerShortcuts, props.isVisible]);
    const labels = localizeBoardChrome(props.translate);
    const canRead = (id: BoardCommand) => id === 'copy' || id === 'selectAll' || id === 'copyAsPng'
        || id === 'copyAsSvg' || id === 'copyAsJson' || id === 'exportPng' || id === 'exportSvg';
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
    const preferences = preferenceEntries({ local: props.localPreferences, label: labels.preferenceLabel, theme, language });
    const editAction = (id: MainAction) => id === 'uploadMedia' || id === 'insertEmbed' || id === 'unlockAll'
        || id === 'convertToBookmark' || id === 'convertToEmbed';
    const actionState = (id: MainAction): CommandState => {
        if (props.readOnly && editAction(id)) return { enabled: false, reason: props.readOnlyReason };
        return id === 'keyboardShortcuts' ? { enabled: true } : props.actionState(id);
    };
    const runAction = (id: MainAction) => {
        if (!actionState(id).enabled) return;
        if (id === 'keyboardShortcuts') {
            setReturnFocus(null);
            setShortcutsOpen(true);
        } else return props.runAction(id);
    };
    const actions = { actionLabel: labels.actionLabel, actionShortcut: (id: MainAction) => props.actionShortcut(id),
        actionState, runAction };
    const menu: MainMenuSource = {
        ...commandSource, ...actions, sectionLabel: labels.mainSectionLabel, preferences,
        copyAsLabel: labels.contextSectionLabel('copyAs'), transparentLabel: labels.text('transparent'),
        transparent: props.localPreferences.view.transparent, debugMode: props.localPreferences.view.debugMode,
        toggleTransparent: () => props.localPreferences.setView('transparent', !props.localPreferences.view.transparent),
    };
    if (!props.isVisible) return null;
    return <>
        <ConnectedBoardChrome toolState={props.toolState} openMedia={props.openMedia}
            locale={props.locale} direction={props.direction} commands={commandSource}
            menuLabel={labels.text('menu')} menuEntries={anchor => mainMenuEntries({ ...menu, runAction: id => {
                if (id === 'keyboardShortcuts') { setReturnFocus(anchor); setShortcutsOpen(true); }
                else return runAction(id);
            } })} sheetName={props.sheetName}
            openSheets={props.openSheets} actionsLabel={labels.text('actions')}
            toolLabel={labels.toolLabel} toolShortcut={props.toolShortcut} toolsLabel={labels.text('tools')}
            moreLabel={labels.text('more')} readOnly={props.readOnly} readOnlyReason={props.readOnlyReason}
            toolDisabledReason={choice => {
                const state = props.toolStateFor(choice.id, choice.figure);
                return state.enabled ? undefined : state.reason;
            }} focusMode={props.localPreferences.view.focusMode}
            penPanel={props.penPanel ? { ...props.penPanel, disabled: props.readOnly || props.penPanel.disabled } : undefined}
            debug={props.debug}
            zoomControls={{ zoom: props.zoom, locale: props.locale, direction: props.direction,
                zoomLabel: labels.text('zoom'), minimapLabel: labels.text('minimap'),
                minimapVisible: props.minimapVisible, commands: actions }} />
        {shortcutsOpen && <ShortcutsDialog label={labels.text('keyboardShortcuts')} locale={props.locale}
            direction={props.direction} closeLabel={labels.text('close')}
            groups={localizeShortcutGroups(props.shortcuts, props.translate)} returnFocus={returnFocus} onClose={closeShortcuts} />}
    </>;
}
