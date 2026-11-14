import type { ContextMenuSubmenu } from '../../../utils/contextMenu';
import { updateBoardPreferences } from '../../../utils/boardPreferences';

export interface LanguageOption { readonly code: string; readonly name: string }

export function persistBoardLanguage(locale: string): void { updateBoardPreferences({ locale }); }

export function boardLanguageMenu(
    label: string,
    current: string,
    locales: readonly LanguageOption[],
    select: (code: string) => Promise<void>,
    reportError: (error: unknown) => void,
): ContextMenuSubmenu {
    return { kind: 'submenu', id: 'language', label, entries: locales.map(locale => ({
        kind: 'command', id: `language-${locale.code}`, label: locale.name, checked: locale.code === current,
        run: () => select(locale.code).catch(reportError),
    })) };
}
