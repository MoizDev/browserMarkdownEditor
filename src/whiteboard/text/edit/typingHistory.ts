import type { HistoryController } from '../../change/historyTypes';
import type { EditSelection, TextChange } from './host';

// Only one uncommitted rule mark is retained here. The document inverses and
// selection snapshots stay in the shared history, not in a second undo stack.
export class TypingHistory {
    private open = false;
    private lastTime = 0;
    private lastCaret: number | null = null;
    private count = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private rule: { mark: number; before: EditSelection } | null = null;

    constructor(private readonly history: HistoryController, private readonly restore: (selection: EditSelection) => void) {}

    begin(kind: 'typing' | 'composition' | 'boundary', before: EditSelection, _after: EditSelection, change?: TextChange): void {
        if (kind === 'boundary') { this.close(); return; }
        const now = performance.now();
        const adjacent = change && before.anchor === before.focus && this.lastCaret === before.focus
            && change.from <= before.focus && change.to >= before.focus;
        if (kind === 'composition' || !this.open || !adjacent || now - this.lastTime >= 1000 || this.count >= 2000) {
            this.close();
            this.history.open(kind === 'composition' ? 'Compose text' : 'Edit text');
            this.open = true;
        }
        this.rule = null;
        this.lastTime = now;
        if (change) this.count += Math.max(change.text.length, change.to - change.from);
        this.resetTimer();
    }

    complete(kind: 'typing' | 'composition' | 'boundary', after: EditSelection): void {
        if (kind === 'boundary') return;
        this.lastCaret = after.focus;
        if (kind === 'composition') this.close();
    }

    mark(): number { return this.history.mark(); }
    remember(mark: number, before: EditSelection): void { this.rule = { mark, before }; }
    undoTransformation(): boolean {
        if (!this.rule || !this.open) return false;
        const rule = this.rule;
        this.rule = null;
        this.history.rollbackTo(rule.mark);
        this.restore(rule.before);
        this.lastCaret = rule.before.focus;
        this.resetTimer();
        return true;
    }

    close(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.open) this.history.close();
        this.open = false; this.lastCaret = null; this.count = 0; this.rule = null;
    }
    dispose(): void { this.close(); }
    private resetTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.close(), 1000);
    }
}
