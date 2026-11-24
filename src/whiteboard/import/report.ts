// IMP-5: callers retain the complete report even when the host displays only a summary.
// `item` names what an unrepresentable issue cost the person, as a countable noun ("embed", "unknown shape"); issues
// without one are about the file as a whole. `notice` on a repair is the plain fragment the board notice shows for it
// ("pressure lost", counted by its `item`); repairs without one are bookkeeping the person need not read (a preserved
// extra field, a pen lift's float16 drift).
export interface ImportIssue {
    readonly id: string | null;
    readonly reason: string;
    readonly item?: string;
    readonly notice?: string;
}
export interface ImportReport {
    readonly counts: Readonly<Record<string, number>>;
    readonly repairs: readonly ImportIssue[];
    readonly unrepresentable: readonly ImportIssue[];
}
export class ReportBuilder {
    private readonly counts: Record<string, number> = Object.create(null) as Record<string, number>;
    private readonly repairs: ImportIssue[] = [];
    private readonly unrepresentable: ImportIssue[] = [];
    count(kind: string): void { this.counts[kind] = (this.counts[kind] ?? 0) + 1; }
    include(report: ImportReport): void {
        for (const [kind, count] of Object.entries(report.counts)) this.counts[kind] = (this.counts[kind] ?? 0) + count;
        this.repairs.push(...report.repairs);
        this.unrepresentable.push(...report.unrepresentable);
    }
    /** `notice` and `item` together put a repair in the board notice: "pressure lost on 2 strokes". */
    repair(id: string | null, reason: string, notice?: string, item = 'item'): void {
        this.repairs.push(notice ? { id, reason, notice, item } : { id, reason });
    }
    refuse(id: string | null, reason: string, item?: string): void {
        this.unrepresentable.push(item ? { id, reason, item } : { id, reason });
    }
    finish(): ImportReport {
        return { counts: { ...this.counts }, repairs: [...this.repairs], unrepresentable: [...this.unrepresentable] };
    }
}

// A noun phrase is counted by its head: "2 pictures without their files", "3 items off the pages". Pluralised as one word,
// two missing pictures read "2 picture without its files".
const plural = (count: number, noun: string): string => {
    if (count === 1) return noun;
    const without = / without its (.+)$/.exec(noun);
    if (without) return `${plural(count, noun.slice(0, without.index))} without their ${plural(count, without[1])}`;
    if (noun.endsWith(' off the pages')) return `${plural(count, noun.slice(0, -' off the pages'.length))} off the pages`;
    return /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
};

/** Groups equal texts, most frequent first, as "text (×3)", capped at `cap` distinct texts then "+N more".
 * One reason per shape joined raw printed the user's board as "Invalid stroke coordinate or pressure; …" 45 times. */
export function groupIssueText(texts: readonly string[], cap = 4): string {
    const counts = new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, cap).map(([text, count]) => count > 1 ? `${text} (×${count})` : text);
    const rest = sorted.length - cap;
    return rest > 0 ? `${shown.join('; ')}; +${rest} more` : shown.join('; ');
}

/** Counted nouns, most frequent first: "2 embeds, 1 unknown shape", capped like groupIssueText. */
function countNouns(nouns: readonly string[], cap = 4): string {
    const counts = new Map<string, number>();
    for (const noun of nouns) counts.set(noun, (counts.get(noun) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, cap).map(([noun, count]) => `${count} ${plural(count, noun)}`);
    const rest = sorted.length - cap;
    return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
}

/** The one sentence a board that cannot be read at all shows. */
export function importFailure(prefix: string, issues: readonly ImportIssue[]): string {
    const reasons = groupIssueText(issues.map(issue => issue.reason));
    return reasons ? `${prefix}: ${reasons}.` : `${prefix}.`;
}

/** The board's own notice after an import that opened: what was left out, and the repairs the person would care
 * about, each grouped and counted, then `closing` (where the left-out items are kept), told how many were left out so
 * its pronoun agrees: "1 item … could not be shown (…). They are still in the file" read wrong. Null when there is
 * nothing worth reading. */
export function importNotice(report: ImportReport, closing: (leftOut: number) => string): string | null {
    const parts: string[] = [];
    const lost = report.unrepresentable.filter(issue => issue.item);
    if (lost.length) {
        parts.push(`${lost.length} ${plural(lost.length, 'item')} from the old board could not be shown (${countNouns(lost.map(issue => issue.item!))}).`);
    }
    const repaired = report.repairs.filter(issue => issue.notice);
    if (repaired.length) {
        // Counted per item, not per repair: one stroke with two kinds of loss is one stroke under each.
        const byNotice = new Map<string, { item: string; ids: Set<string | null> }>();
        for (const issue of repaired) {
            let entry = byNotice.get(issue.notice!);
            if (!entry) byNotice.set(issue.notice!, entry = { item: issue.item ?? 'item', ids: new Set() });
            entry.ids.add(issue.id);
        }
        const text = [...byNotice].sort((a, b) => b[1].ids.size - a[1].ids.size).slice(0, 4)
            .map(([notice, { item, ids }]) => `${notice} on ${ids.size} ${plural(ids.size, item)}`);
        const sentence = `${text.join(', ')}${byNotice.size > 4 ? `, +${byNotice.size - 4} more` : ''}.`;
        parts.push(sentence[0].toUpperCase() + sentence.slice(1));
    }
    if (!parts.length) return null;
    return `${parts.join(' ')} ${closing(lost.length)}`;
}
