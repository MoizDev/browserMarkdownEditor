import type { ContextMenuSubmenu } from '../../../utils/contextMenu';
import { getBoardPreferences, updateBoardPreferences } from '../../../utils/boardPreferences';

export type ThemeChoice = 'light' | 'dark' | 'system';
export function readStoredBoardTheme(): ThemeChoice { return getBoardPreferences().colorScheme; }

export function persistBoardTheme(value: ThemeChoice): void { updateBoardPreferences({ colorScheme: value }); }

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
