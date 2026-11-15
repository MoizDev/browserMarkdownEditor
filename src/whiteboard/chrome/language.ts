import locales from '../../utils/boardLocales.json';

export interface LanguageTable {
    readonly dir: 'ltr' | 'rtl';
    readonly englishTerms: readonly { readonly key: string; readonly text: string; readonly reason: string }[];
    readonly strings: Readonly<Record<string, string>>;
}

export interface BoardLocale { readonly code: string; readonly name: string; readonly dir: 'ltr' | 'rtl'; readonly ready: boolean }
export const boardLocales: readonly BoardLocale[] = locales as readonly BoardLocale[];
// Each table is a typed module (see boardLanguageTable.ts): completeness and placeholder parity are compile-time facts.
const files = import.meta.glob<{ default: LanguageTable }>('./i18n/*.ts');
export function availableBoardLocales(): readonly BoardLocale[] {
    return boardLocales.filter(locale => locale.ready && !!files[`./i18n/${locale.code}.ts`]);
}
const cache = new Map<string, Promise<LanguageTable>>();

async function fetchTable(code: string): Promise<LanguageTable> {
    const load = files[`./i18n/${code}.ts`];
    if (!load || !boardLocales.some(item => item.code === code && item.ready)) throw new RangeError(`Unsupported board language: ${code}`);
    const value = (await load()).default;
    if (!value || !value.strings || !Array.isArray(value.englishTerms) || (value.dir !== 'ltr' && value.dir !== 'rtl')) {
        throw new Error(`Invalid board language table: ${code}`);
    }
    return value;
}

export function loadBoardLanguage(code: string): Promise<LanguageTable> {
    const known = cache.get(code);
    if (known) return known;
    const pending = (async () => {
        const table = await fetchTable(code);
        const locale = boardLocales.find(item => item.code === code);
        if (table.dir !== locale?.dir) throw new Error(`Incorrect language direction: ${code}`);
        return table;
    })();
    cache.set(code, pending);
    void pending.catch(() => cache.delete(code));
    return pending;
}

export function translateBoard(table: LanguageTable, key: string, values: Readonly<Record<string, string | number>> = {}): string {
    // Total: a complete table has no missing key (the type check guarantees it), and a stray dynamic key shows its id
    // rather than unmounting the board.
    const template = table.strings[key] as string | undefined;
    if (template === undefined) return key;
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`Missing translation parameter: ${key}/${name}`);
        return String(value);
    });
}

export interface BoardLanguageSnapshot {
    readonly locale: string;
    readonly table: LanguageTable;
}

export class BoardLanguageState {
    private readonly listeners = new Set<() => void>();
    private generation = 0;
    private snapshot: BoardLanguageSnapshot;

    constructor(locale: string, table: LanguageTable, private readonly persist: (locale: string) => void) {
        this.snapshot = { locale, table };
    }
    getSnapshot = (): BoardLanguageSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    async select(locale: string, persist = true): Promise<void> {
        const generation = ++this.generation;
        if (locale === this.snapshot.locale) return;
        const table = await loadBoardLanguage(locale);
        if (generation !== this.generation) return;
        this.snapshot = { locale, table };
        if (persist) this.persist(locale);
        for (const listener of this.listeners) listener();
    }
}

export function translateBoardCount(table: LanguageTable, locale: string, key: string, count: number): string {
    const category = new Intl.PluralRules(locale).select(count);
    const form = `${key}.${category}`;
    return translateBoard(table, form in table.strings ? form : `${key}.other`, { count });
}
