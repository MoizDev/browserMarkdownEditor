import type { ContextMenuSubmenu } from '../../../utils/contextMenu';
import { writeStoredValue } from '../../../utils/storage';

export type ThemeChoice = 'light' | 'dark' | 'system';
const key = 'bme.whiteboard.theme';

export function readStoredBoardTheme(): ThemeChoice {
    try {
        const value = localStorage.getItem(key);
        return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
    } catch { return 'system'; }
}

export function persistBoardTheme(value: ThemeChoice): void { writeStoredValue(key, value); }

export function boardThemeMenu(
    kind: 'whiteboard' | 'notebook' | 'pdf-ink',
    current: ThemeChoice,
    label: string,
    labels: Readonly<Record<ThemeChoice, string>>,
    setTheme: (value: ThemeChoice) => void,
): ContextMenuSubmenu | null {
    if (kind !== 'whiteboard') return null;
    return {
        kind: 'submenu', id: 'theme', label,
        entries: (['dark', 'light', 'system'] as const).map(value => ({
            kind: 'command', id: `theme-${value}`, label: labels[value], checked: current === value,
            run: () => setTheme(value),
        })),
    };
}
