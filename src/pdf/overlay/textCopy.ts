import { copyText, CLIPBOARD_WRITE_BLOCKED } from '../../utils/clipboard';
import { pdfSelectionQuote } from '../../utils/pdfTextMenu';
import { COPY_TOO_LARGE, MAX_COPY_UTF16_UNITS, copySelection, normalizeForClipboard } from '../text/copy';
import { selectionRange } from '../text/selection';
import type { PdfSelection } from '../text/selection';

export interface PdfTextCopyHost {
    selection(): PdfSelection | null;
    pageCount(): number;
    cachedText(page: number): string | undefined;
    /** Active copy is priority 1, not background indexing. */
    text(page: number, signal: AbortSignal): Promise<string>;
    /** Rechecked before publication, including immediately before a queued clipboard write. */
    isCurrent(): boolean;
    fontEpoch(): number;
    notice(message: string): void;
}
export interface PdfTextCopyBinding {
    copy(): Promise<void>;
    copyQuote(filename: string, path: string): Promise<void>;
    /** Call on selection, docKey or visibility change. */
    /** Returns true when an in-flight gather was cancelled. */
    cancel(): boolean;
    dispose(): void;
}
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
// Clipboard writes are app-global, so two PDF panes cannot race completion.
let latestCopy = 0, writes = 0, writeTail: Promise<void> = Promise.resolve();
function writeLatest(text: string, ticket: number, valid: () => boolean): Promise<boolean | undefined> {
    writes++;
    const run = writeTail.then(async () => ticket === latestCopy && valid() ? copyText(text) : undefined);
    writeTail = run.then(() => {}, () => {}).finally(() => { writes--; });
    return run;
}
export function beginPdfCopy(): { write(text: string, valid: () => boolean): Promise<boolean | undefined> } {
    const ticket = ++latestCopy;
    return { write: (text, valid) => writeLatest(text, ticket, valid) };
}
function sameSelection(a: PdfSelection, b: PdfSelection | null): boolean {
    return !!b && a.docKey === b.docKey && a.wholeDocument === b.wholeDocument && a.granularity === b.granularity &&
        a.anchor.page === b.anchor.page && a.anchor.offset === b.anchor.offset && a.anchor.affinity === b.anchor.affinity &&
        a.focus.page === b.focus.page && a.focus.offset === b.focus.offset && a.focus.affinity === b.focus.affinity;
}
function snapshot(value: PdfSelection): PdfSelection { return { ...value, anchor: { ...value.anchor }, focus: { ...value.focus } }; }

/** Extends the tiled pane's copy event; it installs no competing Select All handler. */
export function bindPdfTextCopy(element: HTMLElement, host: PdfTextCopyHost): PdfTextCopyBinding {
    let pending: AbortController | null = null, disposed = false, localEpoch = 0;
    const cancel = (silent = false) => {
        const hadPending = !!pending;
        ++localEpoch; pending?.abort(); pending = null;
        host.notice(hadPending && !silent ? 'Copy cancelled' : '');
        return hadPending;
    };
    const initial = (selection: PdfSelection) => {
        const count = host.pageCount(), pages = new Map<number, string>(), range = selectionRange(selection);
        const first = selection.wholeDocument ? 0 : Math.max(0, Math.min(count - 1, range.start.page));
        const last = selection.wholeDocument ? count - 1 : Math.max(first, Math.min(count - 1, range.end.page));
        for (let page = first; page <= last; page++) {
            const text = host.cachedText(page);
            if (text !== undefined) pages.set(page, text);
        }
        return { count, pages, first, last, range };
    };
    const gather = async (selection: PdfSelection, state: ReturnType<typeof initial>, ticket: number, fontEpoch: number, format: (text: string) => string = text => text) => {
        cancel(true);
        const controller = new AbortController(), epoch = localEpoch; pending = controller;
        const valid = () => !disposed && epoch === localEpoch && !controller.signal.aborted && host.isCurrent() && host.fontEpoch() === fontEpoch &&
            sameSelection(selection, host.selection()) && host.pageCount() === state.count;
        const parts: string[] = [];
        let units = 0, normalizedUnits = 0, previousEndsInLF = false;
        try {
            for (let page = state.first; page <= state.last; page++) {
                if (!valid()) return;
                host.notice(`Copying ${page - state.first + 1} of ${state.last - state.first + 1} pages…`);
                const text = state.pages.get(page) ?? await host.text(page, controller.signal);
                if (!valid()) return;
                const from = !selection.wholeDocument && page === state.first ? Math.max(0, Math.min(text.length, state.range.start.offset)) : 0;
                const to = !selection.wholeDocument && page === state.last ? Math.max(from, Math.min(text.length, state.range.end.offset)) : text.length;
                const separator = page > state.first && !previousEndsInLF ? '\n' : '';
                units += to - from + separator.length;
                if (units > MAX_COPY_UTF16_UNITS) { host.notice(COPY_TOO_LARGE); return; }
                if (separator) { parts.push(separator); normalizedUnits++; }
                previousEndsInLF = to > from && text[to - 1] === '\n';
                // Clipboard normalization is code-point local; never split a surrogate pair.
                for (let offset = from; offset < to;) {
                    let end = Math.min(to, offset + 4096);
                    if (end < to && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
                    const part = normalizeForClipboard(text.slice(offset, end));
                    normalizedUnits += part.length;
                    if (normalizedUnits > MAX_COPY_UTF16_UNITS) { host.notice(COPY_TOO_LARGE); return; }
                    parts.push(part); offset = end;
                    if (!valid()) return;
                    await yieldTask();
                }
            }
            if (!valid()) return;
            const result = parts.join('');
            if (result.length > MAX_COPY_UTF16_UNITS) { host.notice(COPY_TOO_LARGE); return; }
            const copied = await writeLatest(format(result), ticket, valid);
            if (valid() && copied !== undefined) host.notice(copied ? '' : CLIPBOARD_WRITE_BLOCKED);
        } catch (error) {
            if (valid()) host.notice(`Could not copy PDF text: ${error instanceof Error ? error.message : String(error)}`);
        } finally { if (pending === controller) pending = null; }
    };
    const copy = async (quote?: { filename: string; path: string }) => {
        const current = host.selection();
        if (!current || disposed || !host.isCurrent()) return;
        const fontEpoch = host.fontEpoch(), selection = snapshot(current), state = initial(selection), ticket = ++latestCopy;
        const result = copySelection(selection, state.count, state.pages);
        const format = quote ? (text: string) => pdfSelectionQuote(text, quote.filename, quote.path, state.first, state.last) : (text: string) => text;
        if (result.kind === 'too-large') { cancel(); host.notice(result.message); return; }
        if (result.kind === 'ready') {
            cancel(true);
            const epoch = localEpoch;
            const valid = () => !disposed && epoch === localEpoch && host.isCurrent() && host.fontEpoch() === fontEpoch && sameSelection(selection, host.selection());
            const copied = await writeLatest(format(result.text), ticket, valid);
            if (valid() && copied === false) host.notice(CLIPBOARD_WRITE_BLOCKED);
            return;
        }
        await gather(selection, state, ticket, fontEpoch, format);
    };
    const onCopy = (event: ClipboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"]')) return;
        const current = host.selection();
        if (!current) return;
        event.preventDefault();
        if (!host.isCurrent()) return;
        const fontEpoch = host.fontEpoch(), selection = snapshot(current), state = initial(selection), result = copySelection(selection, state.count, state.pages), ticket = ++latestCopy;
        if (result.kind === 'ready' && event.clipboardData) {
            cancel(true); event.clipboardData.setData('text/plain', result.text);
            // A delayed restore must not write after a vault switch or a new
            // selection, even if an earlier clipboard request was already live.
            const epoch = localEpoch;
            if (writes) void writeLatest(result.text, ticket, () => !disposed && epoch === localEpoch && host.isCurrent() &&
                host.fontEpoch() === fontEpoch && sameSelection(selection, host.selection()));
        } else if (result.kind === 'too-large') { cancel(); host.notice(result.message); }
        else void gather(selection, state, ticket, fontEpoch);
    };
    element.addEventListener('copy', onCopy);
    return { copy: () => copy(), copyQuote: (filename, path) => copy({ filename, path }), cancel: () => cancel(),
        dispose() { disposed = true; cancel(true); element.removeEventListener('copy', onCopy); } };
}
