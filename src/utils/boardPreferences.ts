import { readJSON, writeJSON } from './storage';
import boardLocales from './boardLocales.json';

const KEY = 'bme.whiteboard.preferences';
const LEGACY_KEY = 'TLDRAW_USER_DATA_v3';
const LOCALES = new Set(boardLocales.map(locale => locale.code));
export interface BoardPreferences {
    version: 1;
    isSnapMode: boolean;
    isWrapMode: boolean;
    isDynamicResizeMode: boolean;
    animationSpeed: number;
    areKeyboardShortcutsEnabled: boolean;
    enhancedA11yMode: boolean;
    inputMode: 'mouse' | 'trackpad' | null;
    isZoomDirectionInverted: boolean;
    edgeScrolling: boolean;
    locale: string;
    colorScheme: 'light' | 'dark' | 'system';
    minimapOpen: boolean;
    paletteRecents: string[];
    sheetListHeight: number | null;
}
export const SHEET_LIST_MIN_HEIGHT = 36;
export const SHEET_LIST_MAX_HEIGHT = 800;
const defaults: BoardPreferences = {
    version: 1, isSnapMode: false, isWrapMode: false, isDynamicResizeMode: false,
    animationSpeed: 1, areKeyboardShortcutsEnabled: true, enhancedA11yMode: false,
    inputMode: null, isZoomDirectionInverted: false, edgeScrolling: true, locale: 'en', colorScheme: 'system', minimapOpen: false, paletteRecents: [], sheetListHeight: null,
};
function osAnimationSpeed(): number {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
}
function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function clamp(value: unknown): BoardPreferences {
    const input = object(value);
    const flag = (key: keyof BoardPreferences, fallback: boolean) => typeof input[key] === 'boolean' ? input[key] as boolean : fallback;
    const locale = typeof input.locale === 'string' && LOCALES.has(input.locale) ? input.locale : defaults.locale;
    return {
        version: 1,
        isSnapMode: flag('isSnapMode', defaults.isSnapMode),
        isWrapMode: flag('isWrapMode', defaults.isWrapMode),
        isDynamicResizeMode: typeof input.isDynamicResizeMode === 'boolean' ? input.isDynamicResizeMode : typeof input.isDynamicSizeMode === 'boolean' ? input.isDynamicSizeMode : defaults.isDynamicResizeMode,
        animationSpeed: typeof input.animationSpeed === 'number' && Number.isFinite(input.animationSpeed) ? Math.max(0, Math.min(1, input.animationSpeed)) : osAnimationSpeed(),
        areKeyboardShortcutsEnabled: flag('areKeyboardShortcutsEnabled', defaults.areKeyboardShortcutsEnabled),
        enhancedA11yMode: flag('enhancedA11yMode', defaults.enhancedA11yMode),
        inputMode: input.inputMode === 'mouse' || input.inputMode === 'trackpad' ? input.inputMode : null,
        isZoomDirectionInverted: flag('isZoomDirectionInverted', defaults.isZoomDirectionInverted),
        edgeScrolling: flag('edgeScrolling', defaults.edgeScrolling),
        locale,
        colorScheme: input.colorScheme === 'light' || input.colorScheme === 'dark' || input.colorScheme === 'system' ? input.colorScheme : defaults.colorScheme,
        minimapOpen: flag('minimapOpen', defaults.minimapOpen),
        paletteRecents: Array.isArray(input.paletteRecents)
            ? input.paletteRecents.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 120).slice(0, 20)
            : defaults.paletteRecents,
        sheetListHeight: typeof input.sheetListHeight === 'number' && Number.isFinite(input.sheetListHeight)
            ? Math.max(SHEET_LIST_MIN_HEIGHT, Math.min(SHEET_LIST_MAX_HEIGHT, input.sheetListHeight)) : null,
    };
}
let current: BoardPreferences | undefined;
const listeners = new Set<(value: BoardPreferences) => void>();
export function getBoardPreferences(): BoardPreferences {
    if (current) return current;
    const saved = readJSON<unknown>(KEY, null);
    if (saved !== null) return current = clamp(object(saved).version === 1 ? saved : {});
    const legacy = object(readJSON<unknown>(LEGACY_KEY, null));
    const user = object(legacy.user);
    current = clamp(user.colorScheme == null && typeof user.isDarkMode === 'boolean'
        ? { ...user, colorScheme: user.isDarkMode ? 'dark' : 'light' } : user);
    writeJSON(KEY, current);
    return current;
}
export function mouseZoomInverted(): boolean {
    const preferences = getBoardPreferences();
    return preferences.inputMode === 'mouse' && preferences.isZoomDirectionInverted;
}
export function mouseInputChosen(): boolean {
    return getBoardPreferences().inputMode === 'mouse';
}
export function updateBoardPreferences(patch: Partial<BoardPreferences>): BoardPreferences {
    const next = clamp({ ...getBoardPreferences(), ...patch });
    if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next;
        writeJSON(KEY, next);
        for (const listener of listeners) listener(next);
    }
    return current!;
}
export function subscribeBoardPreferences(listener: (value: BoardPreferences) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
    if (event.key !== KEY || !event.newValue) return;
    try {
        const value: unknown = JSON.parse(event.newValue);
        current = clamp(object(value).version === 1 ? value : {});
        for (const listener of listeners) listener(current);
    } catch { /* Other windows can retry on their next valid write. */ }
});
