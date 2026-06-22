import { WidgetType } from '@codemirror/view';

/**
 * Parses a raw markdown table string and renders it as an HTML <table> element.
 */
export class TableWidget extends WidgetType {
    rawTable: string;

    constructor(rawTable: string) {
        super();
        this.rawTable = rawTable;
    }

    eq(other: TableWidget): boolean {
        return other.rawTable === this.rawTable;
    }

    toDOM(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'cm-table-widget';

        const lines = this.rawTable.split('\n').filter(l => l.trim().length > 0);
        if (lines.length < 2) {
            container.textContent = this.rawTable;
            return container;
        }

        const parseRow = (line: string): string[] => {
            // Split by | but ignore leading/trailing empty cells from outer pipes
            const cells = line.split('|');
            // Trim the first and last element if they are empty (from leading/trailing |)
            if (cells.length > 0 && cells[0].trim() === '') cells.shift();
            if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
            return cells.map(c => c.trim());
        };

        // Detect separator row (all cells match /^:?-+:?$/)
        const isSeparator = (line: string): boolean => {
            const cells = parseRow(line);
            return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c));
        };

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');

        let headerParsed = false;
        let separatorFound = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!separatorFound && isSeparator(line)) {
                separatorFound = true;
                continue; // Skip the separator row
            }

            const cells = parseRow(line);
            const tr = document.createElement('tr');

            for (const cellText of cells) {
                const cell = document.createElement(!headerParsed ? 'th' : 'td');
                cell.innerHTML = this.renderInlineMarkdown(cellText);
                tr.appendChild(cell);
            }

            if (!headerParsed) {
                thead.appendChild(tr);
                if (separatorFound) headerParsed = true;
            } else {
                tbody.appendChild(tr);
            }
        }

        table.appendChild(thead);
        table.appendChild(tbody);
        container.appendChild(table);

        return container;
    }

    /**
     * Minimal inline markdown renderer for cell contents: bold, italic, bold+italic, code
     */
    renderInlineMarkdown(text: string): string {
        return text
            // Bold+Italic: ***text*** or ___text___
            .replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
            // Bold: **text** or __text__
            .replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
            .replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')
            // Italic: *text* or _text_
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/_(.+?)_/g, '<em>$1</em>')
            // Inline code: `text`
            .replace(/`(.+?)`/g, '<code>$1</code>');
    }
}
