import { openContextMenu } from '../../utils/contextMenu';
import type { ContextMenuEntry } from '../../utils/contextMenu';
import { pdfSelectionQuery } from '../../utils/pdfTextMenu';

/** The viewer resolves a right-click outside the selection to a word before
 * opening this menu. Text is canonical, not reconstructed from the mirror. */
export interface PdfTextMenuOptions {
    x: number; y: number; opener: HTMLElement | null; page: number;
    hasSelection: boolean;
    /** A bounded canonical selection preview, gathered before opening. */
    selectedText: string;
    /** False if the bounded preview omits any part of the selection. */
    selectedTextComplete: boolean;
    copy(): void | Promise<void>;
    copyQuote(): void | Promise<void>;
    searchVault(query: string): void;
    findPdf(query: string): void;
    copyPage(page: number): void | Promise<void>;
    selectAll(): void;
    readText(page: number): void;
}

export function openPdfTextMenu(options: PdfTextMenuOptions): void {
    const { hasSelection, selectedText } = options;
    const entries: ContextMenuEntry[] = [
        { kind: 'command', id: 'copy', label: 'Copy', disabled: !hasSelection,
            reason: hasSelection ? undefined : 'Select text to copy', run: options.copy },
        { kind: 'command', id: 'quote', label: 'Copy as quote', disabled: !hasSelection,
            reason: hasSelection ? undefined : 'Select text to copy', run: options.copyQuote },
    ];
    if (hasSelection) {
        const query = pdfSelectionQuery(selectedText);
        // app-context-menu keeps note contents out of labels; only the query carries selection text.
        entries.push({ kind: 'command', id: 'search-vault', label: 'Search vault for selection', disabled: !query,
            reason: query ? undefined : 'Select searchable text', run: () => options.searchVault(query) });
        if (query && options.selectedTextComplete && !/[\r\n]/u.test(selectedText) && selectedText.length <= 256)
            entries.push({ kind: 'command', id: 'find-pdf', label: 'Find selection in this PDF', run: () => options.findPdf(query) });
    }
    entries.push(
        { kind: 'command', id: 'copy-page', label: 'Copy page text', run: () => options.copyPage(options.page) },
        { kind: 'command', id: 'select-all', label: 'Select all', run: options.selectAll },
        { kind: 'command', id: 'read-text', label: 'Read extracted text', run: () => options.readText(options.page) },
    );
    openContextMenu({ x: options.x, y: options.y, opener: options.opener, label: 'PDF text', entries });
}
