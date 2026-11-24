import type { RichText, Block, Run } from '../text/richText';

export interface ClipboardTextItem {
    readonly text: RichText;
    readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

function ordered(items: readonly ClipboardTextItem[]): ClipboardTextItem[] {
    const sorted = [...items].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
    const rows: ClipboardTextItem[][] = [];
    for (const item of sorted) {
        const row = rows.at(-1);
        const first = row?.[0];
        const overlap = first ? Math.min(first.bounds.y + first.bounds.h, item.bounds.y + item.bounds.h) - Math.max(first.bounds.y, item.bounds.y) : 0;
        if (row && first && overlap > Math.min(first.bounds.h, item.bounds.h) / 2) row.push(item);
        else rows.push([item]);
    }
    return rows.flatMap(row => {
        const rtl = row[0].text.blocks[0]?.dir === 'rtl';
        return row.sort((a, b) => rtl ? b.bounds.x - a.bounds.x : a.bounds.x - b.bounds.x);
    });
}

function blockText(block: Block): string {
    return block.runs.map(run => run.text.replaceAll('\u2028', '\n')).join('');
}

function plain(text: RichText): string {
    const numbers = new Map<number, number>();
    return text.blocks.map(block => {
        let prefix = '';
        if (block.kind === 'ul' || block.kind === 'ol') {
            for (const level of numbers.keys()) if (level > block.level) numbers.delete(level);
            if (block.kind === 'ol') {
                const number = block.start ?? (numbers.get(block.level) ?? 0) + 1;
                numbers.set(block.level, number);
                prefix = `${number}. `;
            } else { numbers.delete(block.level); prefix = '• '; }
            prefix = '  '.repeat(block.level) + prefix;
        } else numbers.clear();
        return prefix + blockText(block);
    }).join('\n');
}

function safeLink(value: string): string | null {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:' ? parsed.href : null;
    } catch { return null; }
}

function appendRun(doc: Document, parent: Element, run: Run): void {
    let target = parent;
    const wrappers: Array<[boolean | undefined, string]> = [
        [run.marks.b, 'strong'], [run.marks.i, 'em'], [run.marks.u, 'u'], [run.marks.s, 's'],
        [run.marks.code, 'code'], [run.marks.hl, 'mark'],
    ];
    const href = run.marks.link ? safeLink(run.marks.link) : null;
    if (href) { const link = doc.createElement('a'); link.setAttribute('href', href); target.append(link); target = link; }
    for (const [enabled, tag] of wrappers) if (enabled) {
        const element = doc.createElement(tag); target.append(element); target = element;
    }
    const lines = run.text.split('\u2028');
    for (let i = 0; i < lines.length; i++) {
        if (i) target.append(doc.createElement('br'));
        target.append(doc.createTextNode(lines[i]));
    }
}

function appendRich(doc: Document, parent: Element, text: RichText): void {
    const lists: { kind: 'ul' | 'ol'; element: Element; last: Element | null }[] = [];
    for (const block of text.blocks) {
        let element: Element;
        if (block.kind === 'ul' || block.kind === 'ol') {
            const level = Math.max(0, Math.min(32, block.level));
            while (lists.length > level + 1) lists.pop();
            if (lists[level]?.kind !== block.kind) lists.splice(level);
            while (lists.length <= level) {
                const list = doc.createElement(block.kind);
                const previous = lists.at(-1);
                if (previous && !previous.last) {
                    previous.last = doc.createElement('li');
                    previous.element.append(previous.last);
                }
                const owner = previous?.last ?? parent;
                owner.append(list);
                lists.push({ kind: block.kind, element: list, last: null });
            }
            const list = lists[level].element;
            if (block.kind === 'ol' && block.start !== undefined && !lists[level].last) list.setAttribute('start', String(block.start));
            element = doc.createElement('li');
            if (block.kind === 'ol' && block.start !== undefined && lists[level].last) element.setAttribute('value', String(block.start));
            list.append(element);
            lists[level].last = element;
        } else {
            lists.length = 0;
            element = doc.createElement(block.kind);
            parent.append(element);
        }
        if (block.dir !== 'auto') element.setAttribute('dir', block.dir);
        for (const run of block.runs) appendRun(doc, element, run);
    }
}

export function clipboardTextRendition(items: readonly ClipboardTextItem[]): { readonly plain: string; readonly element: HTMLDivElement } {
    const doc = document.implementation.createHTMLDocument('');
    const element = doc.createElement('div');
    const texts = ordered(items);
    for (const item of texts) appendRich(doc, element, item.text);
    const plainText = texts.map(item => plain(item.text)).join('\n\n');
    return { plain: plainText || ' ', element };
}
