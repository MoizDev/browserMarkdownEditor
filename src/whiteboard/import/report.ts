// IMP-5: callers retain the complete report even when the host displays only a summary.
export interface ImportIssue { readonly id: string | null; readonly reason: string }
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
    repair(id: string | null, reason: string): void { this.repairs.push({ id, reason }); }
    refuse(id: string | null, reason: string): void { this.unrepresentable.push({ id, reason }); }
    finish(): ImportReport {
        return { counts: { ...this.counts }, repairs: [...this.repairs], unrepresentable: [...this.unrepresentable] };
    }
}
export function importNotice(report: ImportReport): string | null {
    const parts: string[] = [];
    if (report.repairs.length) parts.push(`${report.repairs.length} repair${report.repairs.length === 1 ? '' : 's'}`);
    if (report.unrepresentable.length) parts.push(`${report.unrepresentable.length} unsupported item${report.unrepresentable.length === 1 ? '' : 's'} (read-only)`);
    return parts.length ? `Imported with ${parts.join(' and ')}.` : null;
}
