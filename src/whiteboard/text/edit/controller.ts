import type { Transaction } from '../../change/ops';
import type { NodeId } from '../../model/ids';
import type { Marks, RichText } from '../richText';
import type { EditSelection, TextChange } from './host';
import { linkUrl, type ToggleMark } from './format';
import { inputRule } from './rules';

// The rich-text lane supplies these operations; this controller owns only the
// edit session and sends every content change through the transaction service.
export interface EditTransactions {
    apply(transaction: Transaction): void;
    readText(): RichText;
    markTransformation(): number;
    rememberTransformation(mark: number, before: EditSelection, after: EditSelection): void;
    setSelection(selection: EditSelection): void;
    typing(kind: 'typing' | 'composition' | 'boundary', before: EditSelection, after: EditSelection): void;
    marksAt(offset: number): Marks;
    fragment(from: number, value: string, storedMarks: Marks | null): RichText;
    format(mark: ToggleMark, from: number, to: number): Transaction | null;
    link(url: string, from: number, to: number): Transaction | null;
}

export class TextEditController {
    private storedMarks: Marks | null = null;
    constructor(private readonly id: NodeId, private readonly key: 'text' | 'label', private readonly services: EditTransactions) {}

    setStoredMarks(marks: Marks | null): void { this.storedMarks = marks; }

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

    applyLink(href: string, selection: EditSelection): boolean {
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        const url = linkUrl(href);
        if (!url) return false;
        const tx = this.services.link(url, from, to);
        if (!tx) return false;
        this.services.typing('boundary', selection, selection);
        this.services.apply(tx);
        this.services.setSelection(selection);
        return true;
    }

    replace(change: TextChange, kind: 'typing' | 'composition' | 'boundary', before: EditSelection): EditSelection {
        const fragment = this.services.fragment(change.from, change.text, this.storedMarks);
        this.services.typing(kind, before, change.selection);
        this.services.apply({ origin: 'tool', label: kind === 'composition' ? 'Compose text' : 'Edit text',
            ops: [{ t: 'splice', id: this.id, key: this.key, from: change.from, to: change.to, insert: fragment }] });
        let selection = change.selection;
        if (kind === 'typing' && change.text && selection.anchor === selection.focus) {
            const rule = inputRule(this.id, this.key, this.services.readText(), selection.focus);
            if (rule) {
                const after = { anchor: rule.caret, focus: rule.caret };
                const mark = this.services.markTransformation();
                this.services.apply(rule.transaction);
                this.services.rememberTransformation(mark, selection, after);
                selection = after;
            }
        }
        this.services.setSelection(selection);
        return selection;
    }
}
