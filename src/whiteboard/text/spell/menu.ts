export interface Misspelling { readonly from: number; readonly to: number; readonly word: string }
export interface SpellMenuRows {
    readonly suggestions: readonly string[];
    readonly canAdd: boolean;
    choose(suggestion: string): void;
    add(): void;
}
export interface SpellMenuServices {
    revision(): number;
    suggest(word: string): Promise<readonly string[]>;
    canAdd(word: string): boolean;
    add(word: string): void;
    replace(range: Misspelling, suggestion: string): void;
    open(rows: SpellMenuRows | null): void;
}

// The capture belongs to one text revision; an agent edit or undo while the
// menu is open invalidates it rather than replacing a newly shifted range.
export class SpellingMenuRequest {
    private serial = 0;
    constructor(private readonly services: SpellMenuServices) {}

    async open(range: Misspelling): Promise<void> {
        const serial = ++this.serial;
        const revision = this.services.revision();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<readonly string[]>(resolve => { timer = setTimeout(() => resolve([]), 250); });
        const suggestions = await Promise.race([Promise.resolve().then(() => this.services.suggest(range.word)).catch(() => []), timeout]);
        if (timer !== undefined) clearTimeout(timer);
        if (serial !== this.serial) return;
        if (revision !== this.services.revision()) { this.services.open(null); return; }
        this.services.open({
            suggestions: suggestions.slice(0, 5), canAdd: this.services.canAdd(range.word),
            choose: suggestion => {
                if (serial === this.serial && revision === this.services.revision()) this.services.replace(range, suggestion);
                this.serial++;
            },
            add: () => {
                if (serial === this.serial && this.services.canAdd(range.word)) this.services.add(range.word);
                this.serial++;
            },
        });
    }

    cancel(): void { this.serial++; }
}
