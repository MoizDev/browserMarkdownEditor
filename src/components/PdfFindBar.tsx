import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PdfFindEngine, PdfFindHit, PdfFindProgress } from '../utils/pdfFind';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import { dismissOnEscape } from '../utils/escapeDismiss';
import { openContextMenu } from '../utils/contextMenu';
import { copyText, readClipboardText, CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import './PdfFindBar.css';

export interface PdfFindStart { page: number; y: number }
export interface PdfFindBarHandle {
    openFind(): void;
    nextMatch(direction: 1 | -1): void;
    cancelReveal(): void;
    closeFind(): boolean;
}
interface PdfFindBarProps {
    engine?: PdfFindEngine;
    memory: PdfFindMemory;
    isVisible: boolean;
    isActive: boolean;
    selectedText(): string;
    readingPosition(): PdfFindStart;
    atOrAfter(hit: PdfFindHit, start: PdfFindStart, signal: AbortSignal): boolean | Promise<boolean>;
    reveal(hit: PdfFindHit, signal: AbortSignal): Promise<void>;
    publish(hits: readonly PdfFindHit[], current?: PdfFindHit): void;
    close(current?: PdfFindHit): void;
    onNotify?(message: string): void;
}
const keyOf = (hit?: PdfFindHit) => hit ? `${hit.page}:${hit.from}:${hit.to}` : '';
const cancelled = (error: unknown) => error instanceof Error && (error.name === 'AbortError' || error.name === 'AbortException');
function mergeHits(a: readonly PdfFindHit[], b: readonly PdfFindHit[]) {
    return [...new Map([...a, ...b].map(hit => [keyOf(hit), hit])).values()].sort((x, y) => x.page - y.page || x.from - y.from);
}
/** Known neighbours can straddle the scan's still-unvisited gap. Document-order
 * array wrapping alone would jump over that gap before it has been searched. */
function canStep(from: PdfFindHit, to: PdfFindHit, direction: 1 | -1, progress: PdfFindProgress, start: number) {
    if (progress.done) return true;
    if (from.page === to.page) return direction === 1 ? to.from > from.from : to.from < from.from;
    const distance = (page: number) => (page - start + progress.pagesTotal) % progress.pagesTotal;
    const a = distance(from.page), b = distance(to.page);
    return direction === 1 ? b > a && b < progress.pagesDone : b < a && a < progress.pagesDone;
}

function PdfFindBar(props: PdfFindBarProps, forwarded: React.ForwardedRef<PdfFindBarHandle>) {
    const live = useRef(props); live.current = props;
    const input = useRef<HTMLInputElement>(null), qualityId = React.useId();
    const [open, setOpen] = useState(props.memory.open), [query, setQuery] = useState(props.memory.query);
    const [composing, setComposing] = useState(false);
    const [view, setView] = useState<{ progress?: PdfFindProgress; current?: PdfFindHit; issue?: string }>({});
    const openRef = useRef(open); openRef.current = open;
    const queryRef = useRef(query); queryRef.current = query;
    const composingRef = useRef(false), focusPending = useRef(props.memory.open), explicitFocus = useRef(false);
    const scan = useRef<AbortController | undefined>(undefined), reveal = useRef<AbortController | undefined>(undefined);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const data = useRef<PdfFindProgress | undefined>(undefined), current = useRef<PdfFindHit | undefined>(undefined);
    const start = useRef<PdfFindStart>({ page: 0, y: 0 });
    const lastQuery = useRef(''), lastEngine = useRef<PdfFindEngine | undefined>(undefined);
    const pending = useRef(0), needsReveal = useRef(false), serial = useRef(0);
    const memorySeen = useRef(props.memory), engineSeen = useRef(props.engine);
    const stopTimer = useCallback(() => { if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined; }, []);
    const cancelReveal = useCallback(() => { needsReveal.current = false; reveal.current?.abort(); }, []);
    const show = useCallback((issue?: string) => {
        setView({ progress: data.current, current: current.current, issue });
        live.current.publish(data.current?.hits ?? [], current.current);
    }, []);
    const revealCurrent = useCallback((signal: AbortSignal) => {
        const hit = current.current;
        if (!hit || !live.current.isVisible || composingRef.current) return;
        reveal.current?.abort();
        const task = new AbortController(); reveal.current = task; needsReveal.current = true;
        void live.current.reveal(hit, AbortSignal.any([task.signal, signal])).then(() => {
            if (reveal.current === task) needsReveal.current = false;
        }).catch(error => {
            if (!task.signal.aborted && !signal.aborted && live.current.isVisible && !cancelled(error)) show('This match could not be revealed. Try the next match.');
        });
    }, [show]);
    const drainSteps = useCallback(() => {
        const progress = data.current, hit = current.current;
        if (!progress?.hits.length || !hit || !pending.current) return;
        let index = progress.hits.findIndex(item => keyOf(item) === keyOf(hit));
        if (index < 0) return;
        if (progress.done) {
            index = (index + pending.current % progress.hits.length + progress.hits.length) % progress.hits.length;
            pending.current = 0;
        } else while (pending.current) {
            const direction = pending.current > 0 ? 1 : -1;
            const next = (index + direction + progress.hits.length) % progress.hits.length;
            if (!canStep(progress.hits[index], progress.hits[next], direction, progress, start.current.page)) break;
            index = next; pending.current -= direction;
        }
        current.current = progress.hits[index];
    }, []);
    const begin = useCallback(async () => {
        stopTimer();
        const p = live.current, text = queryRef.current;
        if (!openRef.current || !p.isVisible || !p.engine || composingRef.current) return;
        scan.current?.abort(); reveal.current?.abort();
        const task = new AbortController(); scan.current = task;
        const id = ++serial.current;
        const resume = lastQuery.current === text && lastEngine.current === p.engine && !!data.current;
        const old = resume ? data.current : undefined;
        lastQuery.current = text; lastEngine.current = p.engine;
        if (!resume) { data.current = undefined; current.current = undefined; pending.current = 0; start.current = p.readingPosition(); }
        if (!text.trim()) { data.current = undefined; current.current = undefined; pending.current = 0; show(); return; }
        show();
        if (resume && needsReveal.current) revealCurrent(task.signal);
        try {
            for await (const batch of p.engine.search(text, start.current.page, task.signal)) {
                if (task.signal.aborted || serial.current !== id || !live.current.isVisible || composingRef.current) return;
                start.current.page = Math.max(0, Math.min(batch.pagesTotal - 1, start.current.page));
                data.current = old && !batch.done ? { ...batch, hits: mergeHits(old.hits, batch.hits), pagesDone: Math.max(old.pagesDone, batch.pagesDone),
                    textlessPages: Math.max(old.textlessPages, batch.textlessPages), failedPages: [...new Set([...old.failedPages, ...batch.failedPages])],
                    partialPages: [...new Set([...old.partialPages, ...batch.partialPages])] } : batch;
                const previous = keyOf(current.current);
                if (current.current && !data.current.hits.some(hit => keyOf(hit) === previous)) current.current = undefined;
                if (!current.current) {
                    for (const hit of data.current.hits) {
                        if (hit.page < start.current.page) continue;
                        if (hit.page > start.current.page || await live.current.atOrAfter(hit, start.current, task.signal)) { current.current = hit; break; }
                        if (task.signal.aborted || serial.current !== id) return;
                    }
                    // A before-position hit on the starting page is last in
                    // the wrap, not a reason to jump before the forward scan ends.
                    if (!current.current && (batch.done || batch.pagesDone >= batch.pagesTotal - start.current.page && data.current.hits.some(hit => hit.page < start.current.page))) current.current = data.current.hits[0];
                }
                if (task.signal.aborted || serial.current !== id || composingRef.current) return;
                const requested = pending.current; drainSteps(); show();
                if (current.current && (keyOf(current.current) !== previous || requested !== pending.current)) revealCurrent(task.signal);
            }
        } catch (error) {
            if (!task.signal.aborted && serial.current === id && live.current.isVisible && !cancelled(error)) show('Could not search this PDF. Close Find and try again.');
        }
    }, [stopTimer, show, revealCurrent, drainSteps]);
    const close = useCallback(() => {
        stopTimer(); scan.current?.abort(); cancelReveal(); ++serial.current; pending.current = 0;
        live.current.memory.open = false; openRef.current = false; setOpen(false);
        live.current.publish([], undefined); live.current.close(current.current);
    }, [stopTimer, cancelReveal]);
    const step = useCallback((direction: 1 | -1) => {
        if (composingRef.current) return;
        if (!openRef.current) { live.current.memory.open = true; openRef.current = true; focusPending.current = true; explicitFocus.current = true; setOpen(true); scan.current = new AbortController(); }
        if (lastQuery.current !== queryRef.current || !data.current || !current.current) { void begin(); return; }
        pending.current = Math.max(-10_000, Math.min(10_000, pending.current + direction));
        const previous = keyOf(current.current), requested = pending.current; drainSteps(); show();
        if (keyOf(current.current) !== previous || requested !== pending.current) revealCurrent(scan.current?.signal.aborted === false ? scan.current.signal : new AbortController().signal);
    }, [begin, drainSteps, show, revealCurrent]);
    useImperativeHandle(forwarded, () => ({
        openFind() {
            if (composingRef.current || !live.current.isVisible) return;
            const selected = live.current.selectedText();
            if (selected && selected.length <= 256 && !selected.includes('\n') && !selected.includes('\r')) {
                queryRef.current = selected; live.current.memory.query = selected; setQuery(selected);
            }
            focusPending.current = true; explicitFocus.current = true; openRef.current = true; live.current.memory.open = true; setOpen(true);
            if (input.current) { input.current.focus(); input.current.select(); focusPending.current = false; explicitFocus.current = false; }
        },
        nextMatch: step, cancelReveal,
        closeFind() { if (!openRef.current || composingRef.current) return false; close(); return true; },
    }), [step, cancelReveal, close]);
    useLayoutEffect(() => {
        if (open && props.isVisible && (props.isActive || explicitFocus.current) && focusPending.current && input.current) {
            input.current.focus(); input.current.select(); focusPending.current = false; explicitFocus.current = false;
        }
    }, [open, props.isVisible, props.isActive]);
    useEffect(() => {
        if (memorySeen.current === props.memory && engineSeen.current === props.engine) return;
        const changedMemory = memorySeen.current !== props.memory;
        memorySeen.current = props.memory; engineSeen.current = props.engine;
        stopTimer(); scan.current?.abort(); cancelReveal(); ++serial.current;
        data.current = undefined; current.current = undefined; lastQuery.current = ''; lastEngine.current = undefined; pending.current = 0;
        if (changedMemory) { setQuery(props.memory.query); setOpen(props.memory.open); }
        show();
    }, [props.memory, props.engine, stopTimer, cancelReveal, show]);
    useEffect(() => {
        if (!open || !props.isVisible || !props.engine || composing) return;
        timer.current = setTimeout(() => { void begin(); }, 120);
        return () => { stopTimer(); scan.current?.abort(); reveal.current?.abort(); };
    }, [query, open, props.isVisible, props.engine, composing, begin, stopTimer]);
    useLayoutEffect(() => {
        if (!props.isVisible || !open) live.current.publish([], undefined);
        else live.current.publish(data.current?.hits ?? [], current.current);
    }, [props.isVisible, open]);
    // Only the focused pane owns Escape outside the input. The input consumes
    // its own Escape before other floating surfaces, like note search does.
    useEffect(() => open && props.isVisible && props.isActive ? dismissOnEscape(close) : undefined, [open, props.isVisible, props.isActive, close]);
    useEffect(() => () => { stopTimer(); scan.current?.abort(); reveal.current?.abort(); live.current.publish([], undefined); }, [stopTimer]);
    function change(value: string) { queryRef.current = value; setQuery(value); if (!composingRef.current) live.current.memory.query = value; }
    function notify(message: string) { if (live.current.onNotify) live.current.onNotify(message); else setView(old => ({ ...old, issue: message })); }
    function contextMenu(event: React.MouseEvent) {
        event.preventDefault();
        const field = event.target instanceof HTMLInputElement ? event.target : undefined;
        if (!field) return;
        const value = field.value, from = field.selectionStart ?? 0, to = field.selectionEnd ?? from, selected = value.slice(from, to);
        const replace = (text: string) => {
            if (!field.isConnected || field.value !== value) return;
            let inserted = text.slice(0, Math.max(0, 256 - (value.length - (to - from))));
            const last = inserted.charCodeAt(inserted.length - 1);
            if (inserted.length < text.length && last >= 0xd800 && last <= 0xdbff) inserted = inserted.slice(0, -1);
            field.focus(); field.setSelectionRange(from, to);
            if (!document.execCommand('insertText', false, inserted)) { field.setRangeText(inserted, from, to, 'end'); change(field.value); }
        };
        openContextMenu({ x: event.clientX, y: event.clientY, opener: field, label: 'PDF find', entries: [
            { kind: 'command', id: 'pdf-find-cut', label: 'Cut', disabled: !selected, reason: selected ? undefined : 'Nothing is selected', run: async () => { if (await copyText(selected)) replace(''); else notify(CLIPBOARD_WRITE_BLOCKED); } },
            { kind: 'command', id: 'pdf-find-copy', label: 'Copy', disabled: !selected, reason: selected ? undefined : 'Nothing is selected', run: async () => { if (!await copyText(selected)) notify(CLIPBOARD_WRITE_BLOCKED); } },
            { kind: 'command', id: 'pdf-find-paste', label: 'Paste', run: async () => { const read = await readClipboardText(); if (!read.ok) notify(CLIPBOARD_READ_BLOCKED); else if (read.text) replace(read.text); } },
            { kind: 'command', id: 'pdf-find-all', label: 'Select all', run: () => { field.focus(); field.select(); } },
        ] });
    }
    if (!open) return null;
    const progress = view.progress, hits = progress?.hits ?? [], index = hits.findIndex(hit => keyOf(hit) === keyOf(view.current));
    const status = view.issue || (!query.trim() ? '' : !progress || index < 0 && !progress.done ? `Searching… ${progress?.pagesDone ?? 0}/${progress?.pagesTotal ?? '…'} pages`
        : hits.length ? `${index + 1} of ${hits.length.toLocaleString('en-US')}${progress.capped || !progress.done ? '+' : ''}` : 'No matches');
    const quality = progress ? [progress.textlessPages ? `${progress.textlessPages} ${progress.textlessPages === 1 ? 'page has' : 'pages have'} no text (scans are not OCR’d)` : '',
        progress.failedPages.length ? `${progress.failedPages.length} ${progress.failedPages.length === 1 ? 'page could' : 'pages could'} not be read` : '',
        progress.partialPages.length ? `${progress.partialPages.length} ${progress.partialPages.length === 1 ? 'page has' : 'pages have'} partial text` : ''].filter(Boolean).join(' · ') : '';
    return <div className="pdf-find-bar" role="search" aria-label="Find in PDF" onContextMenu={contextMenu}
        onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
        onKeyDown={event => {
            if (event.nativeEvent.isComposing || composingRef.current) { if (event.key === 'Escape') event.stopPropagation(); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); event.stopPropagation(); step(event.shiftKey ? -1 : 1); }
        }}>
        <div className="pdf-find-main">
            <input ref={input} type="text" aria-label="Find in PDF" aria-describedby={quality ? qualityId : undefined} placeholder="Find in PDF" maxLength={256} autoComplete="off" spellCheck={false} value={query}
                onChange={event => change(event.target.value)}
                onCompositionStart={() => { composingRef.current = true; setComposing(true); stopTimer(); scan.current?.abort(); reveal.current?.abort(); }}
                onCompositionEnd={event => { composingRef.current = false; setComposing(false); change(event.currentTarget.value); }} />
            <span className="pdf-find-status" role="status" aria-live="polite">{status}</span>
            <button type="button" aria-label="Previous match" data-tooltip="Previous match (⇧↩)" disabled={!hits.length} onClick={() => step(-1)}>‹</button>
            <button type="button" aria-label="Next match" data-tooltip="Next match (↩)" disabled={!hits.length} onClick={() => step(1)}>›</button>
            <button type="button" aria-label="Close PDF find" data-tooltip="Close (Esc)" onClick={close}>×</button>
        </div>
        {quality && <div id={qualityId} className="pdf-find-quality">{quality}</div>}
    </div>;
}
export default React.memo(React.forwardRef(PdfFindBar));
