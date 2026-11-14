import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';

export interface TextMenuActions {
    readonly hasSelection: boolean;
    command(name: 'cut' | 'copy' | 'paste' | 'paste-plain' | 'select-all' | 'bold' | 'italic' | 'code' | 'link' | 'highlight'): void;
    suggest?(word: string): void;
    addToDictionary?(): void;
}
export interface SpellingMenu {
    readonly suggestions: readonly string[];
    readonly canAdd: boolean;
}

export function openTextEditMenu(x: number, y: number, opener: HTMLElement, actions: TextMenuActions, spelling?: SpellingMenu): void {
    const entries: ContextMenuEntry[] = [];
    if (spelling) {
        for (const suggestion of spelling.suggestions.slice(0, 5)) entries.push({ kind: 'command', id: `suggest-${entries.length}`, label: suggestion, run: () => actions.suggest?.(suggestion) });
        if (!spelling.suggestions.length) entries.push({ kind: 'command', id: 'no-suggestions', label: 'No suggestions', disabled: true, reason: 'No spelling suggestions are available', run: () => {} });
        if (spelling.canAdd) entries.push({ kind: 'command', id: 'add-word', label: 'Add to dictionary', run: () => actions.addToDictionary?.() });
        entries.push({ kind: 'separator', id: 'spell-separator' });
    }
    const rows = [
        ['cut', 'Cut'], ['copy', 'Copy'], ['paste', 'Paste'], ['paste-plain', 'Paste as plain text'], ['select-all', 'Select all'],
        ['bold', 'Bold'], ['italic', 'Italic'], ['code', 'Code'], ['link', 'Link'], ['highlight', 'Highlight'],
    ] as const;
    for (const [id, label] of rows) {
        if (id === 'bold') entries.push({ kind: 'separator', id: 'format-separator' });
        const disabled = (id === 'cut' || id === 'copy' || id === 'link') && !actions.hasSelection;
        entries.push({ kind: 'command', id, label, disabled, ...(disabled ? { reason: 'Select text first' } : {}), run: () => actions.command(id) });
    }
    openContextMenu({ x, y, opener, label: 'Text editing', entries });
}
