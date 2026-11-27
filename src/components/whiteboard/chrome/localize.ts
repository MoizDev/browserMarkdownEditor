import type { BoardCommand, ContextSection } from './boardCommands';
import type { MainAction, MainSection } from './mainMenu';
import type { PreferenceLabel } from './preferencesMenu';
import type { ShortcutGroup } from './ShortcutsDialog';
import type { ToolLabel } from './toolChoices';

export type BoardTranslate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export function localizeBoardChrome(t: BoardTranslate) {
    return {
        toolLabel: (key: ToolLabel) => t(`tools.${key}`),
        commandLabel: (key: BoardCommand) => t(`commands.${key}`),
        contextSectionLabel: (key: ContextSection) => t(`sections.${key}`),
        mainSectionLabel: (key: MainSection) => t(`sections.${key}`),
        preferenceLabel: (key: PreferenceLabel) => t(`preferences.${key}`),
        actionLabel: (key: MainAction) => t(key === 'exportPng' || key === 'exportSvg' || key === 'exportPdf' || key === 'exportJson' ? `commands.${key}`
            : key === 'keyboardShortcuts' ? 'chrome.keyboardShortcutsMenu' : key === 'commandPalette' ? 'chrome.commandPaletteMenu' : `chrome.${key}`),
        text: (key: string) => t(`chrome.${key}`),
    };
}

function translatedOr(t: BoardTranslate, key: string, fallback: string): string {
    try { const text = t(key); return text === key ? fallback : text; } catch { return fallback; }
}

export function localizeShortcutGroups(groups: readonly ShortcutGroup[], t: BoardTranslate): readonly ShortcutGroup[] {
    return groups.map(group => ({
        ...group,
        label: t(`shortcutGroups.${group.id === 'style' ? 'transform' : group.id === 'text-formatting' ? 'textFormatting' : group.id}`),
        bindings: group.bindings.map(binding => ({
            ...binding, label: translatedOr(t, `shortcuts.${binding.id.split(':', 1)[0]}`, binding.label),
        })),
    }));
}
