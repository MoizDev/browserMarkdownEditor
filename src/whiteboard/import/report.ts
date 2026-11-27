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
    private readonly named = new Set<string>();
    count(kind: string): void { this.counts[kind] = (this.counts[kind] ?? 0) + 1; }
    include(report: ImportReport): void {
        for (const [kind, count] of Object.entries(report.counts)) this.counts[kind] = (this.counts[kind] ?? 0) + count;
        this.repairs.push(...report.repairs);
        this.unrepresentable.push(...report.unrepresentable);
        for (const issue of report.unrepresentable) if (issue.item && issue.id !== null) this.named.add(issue.id);
    }
    repair(id: string | null, reason: string, notice?: string, item = 'item'): void {
        this.repairs.push(notice ? { id, reason, notice, item } : { id, reason });
    }
    refuse(id: string | null, reason: string, item?: string): void {
        this.unrepresentable.push(item ? { id, reason, item } : { id, reason });
        if (item && id !== null) this.named.add(id);
    }
    refused(id: string): boolean { return this.named.has(id); }
    finish(): ImportReport {
        return { counts: { ...this.counts }, repairs: [...this.repairs], unrepresentable: [...this.unrepresentable] };
    }
}

const plural = (count: number, noun: string): string => {
    if (count === 1) return noun;
    const without = / without its (.+)$/.exec(noun);
    if (without) return `${plural(count, noun.slice(0, without.index))} without their ${plural(count, without[1])}`;
    if (noun.endsWith(' off the pages')) return `${plural(count, noun.slice(0, -' off the pages'.length))} off the pages`;
    return /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
};

export function groupIssueText(texts: readonly string[], cap = 4): string {
    const counts = new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, cap).map(([text, count]) => count > 1 ? `${text} (×${count})` : text);
    const rest = sorted.length - cap;
    return rest > 0 ? `${shown.join('; ')}; +${rest} more` : shown.join('; ');
}

function countNouns(nouns: readonly string[], cap = 4): string {
    const counts = new Map<string, number>();
    for (const noun of nouns) counts.set(noun, (counts.get(noun) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, cap).map(([noun, count]) => `${count} ${plural(count, noun)}`);
    const rest = sorted.length - cap;
    return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
}

export function importFailure(prefix: string, issues: readonly ImportIssue[]): string {
    const reasons = groupIssueText(issues.map(issue => issue.reason));
    return reasons ? `${prefix}: ${reasons}.` : `${prefix}.`;
}

export function importNotice(report: ImportReport, closing: (leftOut: number) => string): string | null {
    const parts: string[] = [];
    const lost = report.unrepresentable.filter(issue => issue.item);
    if (lost.length) {
        parts.push(`${lost.length} ${plural(lost.length, 'item')} from the old board could not be shown (${countNouns(lost.map(issue => issue.item!))}).`);
    }
    const repaired = report.repairs.filter(issue => issue.notice);
    if (repaired.length) {
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
