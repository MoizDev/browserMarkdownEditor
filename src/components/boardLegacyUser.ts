import { atom, computed, createTLCurrentUser } from 'tldraw';
import type { TLUserPreferences } from 'tldraw';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences, type BoardPreferences } from '../utils/boardPreferences';

function fields(value: BoardPreferences) {
    const { version: _version, isDynamicResizeMode, ...preferences } = value;
    return { ...preferences, isDynamicSizeMode: isDynamicResizeMode };
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
        isSnapMode: adjusted.isSnapMode ?? undefined,
        isWrapMode: adjusted.isWrapMode ?? undefined,
        isDynamicResizeMode: adjusted.isDynamicSizeMode ?? undefined,
        animationSpeed: adjusted.animationSpeed ?? undefined,
        areKeyboardShortcutsEnabled: adjusted.areKeyboardShortcutsEnabled ?? undefined,
        enhancedA11yMode: adjusted.enhancedA11yMode ?? undefined,
        inputMode: adjusted.inputMode ?? undefined,
        isZoomDirectionInverted: adjusted.isZoomDirectionInverted ?? undefined,
        locale: adjusted.locale ?? undefined,
        colorScheme: adjusted.colorScheme ?? undefined,
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
