import type { Transaction } from '../../change/ops';
import type { NodeId } from '../../model/ids';
import type { Marks, RichText } from '../richText';
import type { EditSelection, TextChange } from './host';
import { linkUrl, type ToggleMark } from './format';
import { inputRule, typographyRule } from './rules';

// The rich-text lane supplies these operations; this controller owns only the
// edit session and sends every content change through the transaction service.
export interface EditTransactions {
    apply(transaction: Transaction): void;
    readText(): RichText;
    markTransformation(): number;
    rememberTransformation(mark: number, before: EditSelection, after: EditSelection): void;
    setSelection(selection: EditSelection): void;
    typing(kind: 'typing' | 'composition' | 'boundary', before: EditSelection, after: EditSelection, change?: TextChange): void;
    completeTyping(kind: 'typing' | 'composition' | 'boundary', after: EditSelection): void;
    marksAt(offset: number): Marks;
    fragment(from: number, value: string, storedMarks: Marks | null): RichText;
    format(mark: ToggleMark, from: number, to: number): Transaction | null;
    link(url: string | null, from: number, to: number): Transaction | null;
    enter(selection: EditSelection): { readonly transaction: Transaction; readonly selection: EditSelection };
}

/** Typed openers that wrap a selection, with their closers. */
const WRAP_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
    '(': ['(', ')'], '[': ['[', ']'], '{': ['{', '}'], '<': ['<', '>'], '"': ['"', '"'], "'": ["'", "'"],
};

export class TextEditController {
    private storedMarks: Marks | null = null;
    constructor(private readonly id: NodeId, private readonly key: 'text' | 'label', private readonly services: EditTransactions) {}

    setStoredMarks(marks: Marks | null): void { this.storedMarks = marks; }

    cutTransaction(selection: EditSelection): Transaction {
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        if (from === to) throw new Error('There is no text range to cut');
        const fragment = this.services.fragment(from, '', this.storedMarks);
        return { origin: 'tool', label: 'Cut text', ops: [{ t: 'splice', id: this.id, key: this.key, from, to, insert: fragment }] };
    }

    toggleMark(mark: ToggleMark, selection: EditSelection): void {
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        if (from === to) {
            const marks = { ...(this.storedMarks ?? this.services.marksAt(from)) };
            if (marks[mark]) delete marks[mark]; else marks[mark] = true;
            this.storedMarks = marks;
            return;
        }
        const tx = this.services.format(mark, from, to);
        if (tx) { this.services.typing('boundary', selection, selection); this.services.apply(tx); }
    }

    applyLink(href: string | null, selection: EditSelection): boolean {
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        const url = href === null ? null : linkUrl(href);
        if (href !== null && !url) return false;
        if (from === to) {
            const marks = { ...(this.storedMarks ?? this.services.marksAt(from)) };
            if (url === null) delete marks.link; else marks.link = url;
            this.storedMarks = marks;
            return true;
        }
        const tx = this.services.link(url, from, to);
        if (!tx) return false;
        this.services.typing('boundary', selection, selection);
        this.services.apply(tx);
        this.services.setSelection(selection);
        return true;
    }

    enter(selection: EditSelection): EditSelection {
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        this.services.typing('typing', selection, selection, { from, to, text: '\n', selection });
        if (from === to) {
            const rule = inputRule(this.id, this.key, this.services.readText(), from, 'enter');
            if (rule) this.services.apply(rule.transaction);
        }
        const result = this.services.enter(selection);
        this.services.apply(result.transaction);
        this.services.setSelection(result.selection);
        this.services.completeTyping('typing', result.selection);
        return result.selection;
    }

    /** A typed bracket or quote over a selection surrounds it and keeps the selection on the same text. The closer is spliced
     * first, so the opener's offset is still valid when it goes in. */
    private wrap(change: TextChange, pair: readonly [string, string], before: EditSelection): EditSelection {
        const from = change.from, to = change.to;
        const after = { anchor: from + 1, focus: to + 1 };
        const { storedMarks } = this;
        // Inside code the quotes stay straight, as the rest of code text does.
        const [open, close] = pair;
        const marks = this.services.marksAt(from);
        const [left, right] = marks.code ? [open, close] : open === '"' ? ['\u201c', '\u201d'] : open === "'" ? ['\u2018', '\u2019'] : [open, close];
        this.services.typing('boundary', before, after);
        this.services.apply({ origin: 'tool', label: 'Wrap text', ops: [
            { t: 'splice', id: this.id, key: this.key, from: to, to, insert: this.services.fragment(to, right, storedMarks) },
            { t: 'splice', id: this.id, key: this.key, from, to: from, insert: this.services.fragment(from, left, storedMarks) },
        ] });
        this.services.setSelection(after);
        this.services.completeTyping('boundary', after);
        return after;
    }

    replace(change: TextChange, kind: 'typing' | 'composition' | 'boundary', before: EditSelection): EditSelection {
        const wrap = kind === 'typing' && change.from !== change.to && change.text.length === 1 && Object.hasOwn(WRAP_PAIRS, change.text)
            ? WRAP_PAIRS[change.text] : undefined;
        if (wrap) return this.wrap(change, wrap, before);
        const fragment = this.services.fragment(change.from, change.text, this.storedMarks);
        this.services.typing(kind, before, change.selection, change);
        this.services.apply({ origin: 'tool', label: kind === 'composition' ? 'Compose text' : 'Edit text',
            ops: [{ t: 'splice', id: this.id, key: this.key, from: change.from, to: change.to, insert: fragment }] });
        let selection = change.selection;
        if (kind === 'typing' && change.text && selection.anchor === selection.focus) {
            const rule = inputRule(this.id, this.key, this.services.readText(), selection.focus)
                ?? typographyRule(this.id, this.key, this.services.readText(), selection.focus);
            if (rule) {
                const after = { anchor: rule.caret, focus: rule.caret };
                const mark = this.services.markTransformation();
                this.services.apply(rule.transaction);
                this.services.rememberTransformation(mark, selection, after);
                selection = after;
            }
        }
        this.services.setSelection(selection);
        this.services.completeTyping(kind, selection);
        return selection;
    }
}
