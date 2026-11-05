// One tool the agent used, as one row of a step stack (StepStack.tsx): a kind
// icon — a spinner while it runs — then a sentence ("Read", "Searched the vault
// for") and what it acted on, in mono. Our own vault_/canvas_ tools and the
// CLI's own (its shell, file tools, web, sub-agents) share the one look: the
// reader cares what was done, not whose tool did it. The call's input and
// output open INSIDE the row as one quiet mono block.
//
// A text edit or a new note is not a row once it has landed: it becomes a
// change card (ChangeCard.tsx), which is what the reader actually wants to
// see. A move, a trash, a new folder and a canvas edit stay sentences.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { describeTool } from './toolSteps';
import type { StepKind, ToolItem } from './toolSteps';
import { copyText } from '../../utils/clipboard';
import { Bot, Check, ChevronRight, Copy, File, Folder, Globe, Search, Terminal } from './ui/icons';

const KIND_ICON: Record<StepKind, () => ReactNode> = {
    file: () => <File />,
    folder: () => <Folder />,
    search: () => <Search />,
    terminal: () => <Terminal />,
    globe: () => <Globe />,
    bot: () => <Bot />,
};

/** The call's input as `key: value` lines — what a reader scans for — rather
 *  than a JSON object with its quoting. Nested values stay JSON, on one line. */
function inputLines(input: unknown): string {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'object' || Array.isArray(input)) {
        try { return JSON.stringify(input, null, 2); } catch { return String(input); }
    }
    return Object.entries(input as Record<string, unknown>).map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v}`;
        try { return `${k}: ${JSON.stringify(v)}`; } catch { return `${k}: ${String(v)}`; }
    }).join('\n');
}

/** What a canvas edit did, after its path: "3 added, 1 changed". */
function canvasSummary(item: ToolItem): string {
    const change = item.change;
    if (change?.kind !== 'canvas') return '';
    return change.summary || [
        change.created ? `${change.created} added` : '',
        change.updated ? `${change.updated} changed` : '',
        change.deleted ? `${change.deleted} removed` : '',
    ].filter(Boolean).join(', ') || 'No shapes changed';
}

export function ToolStep({ item }: { item: ToolItem }) {
    // null = the reader has not chosen: a failed step opens itself (the output
    // says why it failed), every other one stays shut.
    const [chosen, setChosen] = useState<boolean | null>(null);
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);

    const [running, done, target, kind] = describeTool(item);
    const failed = item.status === 'error';
    const input = inputLines(item.input);
    const output = item.output ?? '';
    const hasDetail = !!input || !!output;
    const open = hasDetail && (chosen ?? failed);
    const extra = item.status === 'done' ? canvasSummary(item) : '';

    const copy = async () => {
        const text = [input && `Input\n${input}`, output && `Output\n${output}`].filter(Boolean).join('\n\n');
        if (!(await copyText(text))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };

    return (
        <div className={'va-step' + (item.status === 'running' ? ' is-running' : '') + (failed ? ' is-failed' : '') + (open ? ' is-open' : '')}>
            <button
                type="button"
                className="va-steprow"
                aria-expanded={hasDetail ? open : undefined}
                // A row with nothing to open is still a button (one look for
                // every row), but an inert one.
                onClick={hasDetail ? () => setChosen(!open) : undefined}
                aria-disabled={hasDetail ? undefined : true}
                tabIndex={hasDetail ? undefined : -1}
            >
                {item.status === 'running'
                    ? <span className="va-spin" role="img" aria-label="Running" />
                    : <span className="va-step-icon" aria-hidden="true">{KIND_ICON[kind]()}</span>}
                {/* "Reading X · failed", never "Read X · failed": it did not. */}
                <span className="va-step-verb">{item.status === 'done' ? done : running}</span>
                {target && <span className="va-step-target">{target}</span>}
                {extra && <span className="va-step-extra">{extra}</span>}
                {failed && <span className="va-step-failed">· failed</span>}
                <ChevronRight className="va-step-chev" aria-hidden="true" style={hasDetail ? undefined : { visibility: 'hidden' }} />
            </button>
            {open && (
                <div className="va-stepdetail">
                    {input && <><span className="va-stepdetail-label">Input</span>{input}</>}
                    {output && <><span className="va-stepdetail-label">Output</span>{output}</>}
                    <button
                        type="button"
                        className="va-stepdetail-copy"
                        aria-label={copied ? 'Copied' : 'Copy input and output'}
                        data-tooltip={copied ? 'Copied' : 'Copy'}
                        data-tooltip-position="left"
                        onClick={() => void copy()}
                    >
                        {copied ? <Check /> : <Copy />}
                    </button>
                </div>
            )}
        </div>
    );
}
