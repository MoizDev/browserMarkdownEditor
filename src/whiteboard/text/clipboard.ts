import { sliceRichText, type Marks, type RichText } from './richText';

export interface TextClipboardRendition {
    readonly plain: string;
    readonly html: string;
    readonly fragment: RichText;
}

function appendRun(doc: Document, parent: Element, text: string, marks: Marks): void {
    let target = parent;
    const wrap = (tag: string): Element => {
        const element = doc.createElement(tag);
        target.appendChild(element);
        target = element;
        return element;
    };
    if (marks.b) wrap('strong');
    if (marks.i) wrap('em');
    if (marks.u) wrap('u');
    if (marks.s) wrap('s');
    if (marks.code) wrap('code');
    if (marks.hl) wrap('mark');
    if (marks.link) {
        try {
            const url = new URL(marks.link);
            if (marks.link.length <= 2048 && ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password)
                wrap('a').setAttribute('href', marks.link);
        } catch { /* Imported invalid links are rendered as text. */ }
    }
    const pieces = text.split('\u2028');
    pieces.forEach((piece, index) => {
        if (index) target.appendChild(doc.createElement('br'));
        target.appendChild(doc.createTextNode(piece));
    });
}

/** Serializes only the selected projection; all user content enters as DOM text. */
export function textClipboardRendition(value: RichText, from: number, to: number): TextClipboardRendition {
    const fragment = sliceRichText(value, from, to);
    const doc = document.implementation.createHTMLDocument('');
    const root = doc.createElement('div');
    const lists: { kind: 'ul' | 'ol'; element: Element; item: Element | null }[] = [];
    const plain: string[] = [];
    for (const block of fragment.blocks) {
        const content = block.runs.map(run => run.text).join('').replace(/\u2028/g, '\n');
        const listKind = block.kind === 'ul' || block.kind === 'ol' ? block.kind : null;
        if (listKind) {
            const level = Math.max(0, Math.min(7, block.level));
            while (lists.length > level + 1) lists.pop();
            if (lists[level] && lists[level].kind !== listKind) lists.length = level;
            while (lists.length <= level) {
                const list = doc.createElement(listKind);
                const container = lists.length ? lists[lists.length - 1].item : root;
                (container ?? root).appendChild(list);
                lists.push({ kind: listKind, element: list, item: null });
            }
            const current = lists[level];
            if (listKind === 'ol' && block.start !== undefined && !current.element.childElementCount)
                current.element.setAttribute('start', String(block.start));
            const item = doc.createElement('li');
            current.element.appendChild(item);
            current.item = item;
            item.setAttribute('dir', block.dir);
            for (const run of block.runs) appendRun(doc, item, run.text, run.marks);
            plain.push(content);
        } else {
            lists.length = 0;
            const element = doc.createElement(block.kind === 'p' ? 'p' : block.kind);
            element.setAttribute('dir', block.dir);
            root.appendChild(element);
            for (const run of block.runs) appendRun(doc, element, run.text, run.marks);
            plain.push(content);
        }
    }
    return { plain: plain.join('\n'), html: root.outerHTML, fragment };
}
