import type { ContextMenuCommand, ContextMenuSubmenu } from '../../../utils/contextMenu';
import { getBoardPreferences, updateBoardPreferences } from '../../../utils/boardPreferences';
import { spacedChord } from './mainMenu';

export type PreferenceLabel = 'alwaysSnap' | 'toolLock' | 'showGrid' | 'selectOnWrap' | 'focusMode'
    | 'edgeScrolling' | 'dynamicSize' | 'pasteAtCursor' | 'inputDevice' | 'autoTrackpad' | 'trackpad' | 'mouse'
    | 'invertMouseZoom' | 'accessibility' | 'reduceMotion' | 'keyboardShortcutsEnabled' | 'enhancedAccessibility'
    | 'debugMode' | 'mouseRequired';

type ViewFlag = 'grid' | 'focusMode' | 'toolLock' | 'transparent' | 'debugMode';
type SessionFlag = 'pasteAtCursor';

export interface LocalPreferencesView {
    readonly view: Readonly<Record<ViewFlag, boolean>>;
    readonly session: Readonly<Record<SessionFlag, boolean>>;
    setView(key: ViewFlag, value: boolean): void;
    setSession(key: SessionFlag, value: boolean): void;
}

export interface PreferenceMenuOptions {
    readonly local: LocalPreferencesView;
    readonly label: (key: PreferenceLabel) => string;
    readonly theme?: ContextMenuSubmenu | null;
    /** The chord of a keyboard binding, by its binding id, when the row has one (Tool lock Q, Show grid, Focus mode). */
    readonly chord?: (bindingId: string) => string | undefined;
}

/** The catalogue's order: the view and session toggles, then Accessibility, Input device and Theme under one divider. */
export function preferenceEntries({ local, label, theme, chord }: PreferenceMenuOptions): ContextMenuSubmenu['entries'] {
    const global = getBoardPreferences();
    const toggle = (id: PreferenceLabel, checked: boolean, run: () => void, disabled = false,
        reason?: string, shortcut?: string): ContextMenuCommand => ({ kind: 'command', id, label: label(id), checked, run, disabled, reason, shortcut });
    const view = (labelId: PreferenceLabel, key: ViewFlag, binding?: string) =>
        toggle(labelId, local.view[key], () => local.setView(key, !local.view[key]), false, undefined, binding ? spacedChord(chord?.(binding)) : undefined);
    const session = (labelId: PreferenceLabel, key: SessionFlag) =>
        toggle(labelId, local.session[key], () => local.setSession(key, !local.session[key]));
    const input: ContextMenuSubmenu = { kind: 'submenu', id: 'inputDevice', label: label('inputDevice'), entries: [
        toggle('autoTrackpad', global.inputMode === null, () => updateBoardPreferences({ inputMode: null })),
        toggle('trackpad', global.inputMode === 'trackpad', () => updateBoardPreferences({ inputMode: 'trackpad' })),
        toggle('mouse', global.inputMode === 'mouse', () => updateBoardPreferences({ inputMode: 'mouse' })),
        toggle('invertMouseZoom', global.isZoomDirectionInverted,
            () => updateBoardPreferences({ isZoomDirectionInverted: !global.isZoomDirectionInverted }),
            global.inputMode !== 'mouse', label('mouseRequired')),
    ] };
    const accessibility: ContextMenuSubmenu = { kind: 'submenu', id: 'accessibility', label: label('accessibility'), entries: [
        toggle('reduceMotion', global.animationSpeed === 0,
            () => updateBoardPreferences({ animationSpeed: global.animationSpeed === 0 ? 1 : 0 })),
        toggle('keyboardShortcutsEnabled', global.areKeyboardShortcutsEnabled,
            () => updateBoardPreferences({ areKeyboardShortcutsEnabled: !global.areKeyboardShortcutsEnabled })),
        toggle('enhancedAccessibility', global.enhancedA11yMode,
            () => updateBoardPreferences({ enhancedA11yMode: !global.enhancedA11yMode })),
    ] };
    return [
        toggle('alwaysSnap', global.isSnapMode, () => updateBoardPreferences({ isSnapMode: !global.isSnapMode })),
        view('toolLock', 'toolLock', 'tool.lock'), view('showGrid', 'grid', 'preferences.grid'),
        toggle('selectOnWrap', global.isWrapMode, () => updateBoardPreferences({ isWrapMode: !global.isWrapMode })),
        view('focusMode', 'focusMode', 'preferences.focus'),
        toggle('edgeScrolling', global.edgeScrolling, () => updateBoardPreferences({ edgeScrolling: !global.edgeScrolling })),
        toggle('dynamicSize', global.isDynamicResizeMode,
            () => updateBoardPreferences({ isDynamicResizeMode: !global.isDynamicResizeMode })),
        session('pasteAtCursor', 'pasteAtCursor'), view('debugMode', 'debugMode'),
        { kind: 'separator', id: 'preferences-divider' },
        accessibility, input,
        ...(theme ? [theme] : []),
    ];
}
