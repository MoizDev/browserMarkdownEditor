import { atom, computed, createTLCurrentUser } from 'tldraw';
import type { TLUserPreferences } from 'tldraw';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences, type BoardPreferences } from '../utils/boardPreferences';

function fields(value: BoardPreferences) {
    const { version: _version, ...preferences } = value;
    return preferences;
}

// Supply the public current-user interface ourselves. This avoids reading or
// writing the library's own persisted user record after the one-time migration.
const preferences = atom<TLUserPreferences>('app board user', {
    id: 'bme-local-user', ...fields(getBoardPreferences()),
});
subscribeBoardPreferences(value => {
    preferences.set({ ...preferences.get(), ...fields(value) });
});
function accept(next: TLUserPreferences, paper: boolean) {
    const current = preferences.get();
    const adjusted = paper ? { ...next, colorScheme: current.colorScheme } : next;
    preferences.set(adjusted);
    updateBoardPreferences({
        isSnapMode: adjusted.isSnapMode,
        isWrapMode: adjusted.isWrapMode,
        isDynamicResizeMode: adjusted.isDynamicResizeMode,
        animationSpeed: adjusted.animationSpeed,
        areKeyboardShortcutsEnabled: adjusted.areKeyboardShortcutsEnabled,
        enhancedA11yMode: adjusted.enhancedA11yMode,
        inputMode: adjusted.inputMode,
        isZoomDirectionInverted: adjusted.isZoomDirectionInverted,
        locale: adjusted.locale,
        colorScheme: adjusted.colorScheme,
    });
}
export const BOARD_USER = createTLCurrentUser({
    userPreferences: preferences,
    setUserPreferences: next => accept(next, false),
});
const paperPreferences = computed('paper user preferences', () => ({
    ...preferences.get(), colorScheme: 'light' as const,
}));
export const PAPER_USER = createTLCurrentUser({
    userPreferences: paperPreferences,
    setUserPreferences: next => accept(next, true),
});
