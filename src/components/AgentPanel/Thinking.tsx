// The agent's thinking: while it thinks, a live label
// with the brightness sweep ("Thinking…") over its reasoning as it streams,
// following the newest line; once done, one quiet line — "Thought for 4s ›" —
// that opens the reasoning again on click. A chat read back from history
// knows no duration, and says only "Thought ›".
//
// With no reasoning at all (a run that has not produced its first token, or an
// agent that does not stream its thinking) it is just the live label — the
// list passes "Reading your view…" / "Stopping…" for the run's other phases.

import { memo, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from './ui/icons';
import { Shimmer } from './ui/Shimmer';

export interface ThinkingProps {
    /** The reasoning so far; empty for a bare live label. */
    text: string;
    live: boolean;
    /** How long it thought, once known. */
    durationMs?: number | null;
    /** The live label; "Thinking…" when omitted. */
    label?: string;
}

function ThinkingImpl({ text, live, durationMs = null, label = 'Thinking…' }: ThinkingProps) {
    const [open, setOpen] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    // The duration is the one thing this row says, and an item rebuilt without
    // it (a re-render from the stored tree) must not turn "Thought for 4s"
    // into "Thought" under the reader's eyes: once known, it is kept.
    const [keptMs, setKeptMs] = useState(durationMs);
    if (durationMs != null && durationMs !== keptMs) setKeptMs(durationMs);
    const ms = durationMs ?? keptMs;
    const seconds = ms != null ? Math.max(1, Math.round(ms / 1000)) : null;

    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const showBody = paragraphs.length > 0 && (live || open);

    // While live the body follows the newest text, as the reasoning is read
    // from its end; opened later it starts from the top.
    useLayoutEffect(() => {
        const el = bodyRef.current;
        if (el && live) el.scrollTop = el.scrollHeight;
    }, [text, live]);

    return (
        <div className="va-think">
            {live ? (
                <div className="va-think-head" role="status">
                    <Shimmer>{label}</Shimmer>
                </div>
            ) : (
                <button
                    type="button"
                    className="va-think-head"
                    aria-expanded={paragraphs.length ? open : undefined}
                    onClick={paragraphs.length ? () => setOpen(o => !o) : undefined}
                >
                    <span>{seconds != null ? `Thought for ${seconds}s` : 'Thought'}</span>
                    {paragraphs.length > 0 && <ChevronRight className="va-think-chev" aria-hidden="true" />}
                </button>
            )}
            {showBody && (
                <div ref={bodyRef} className="va-think-body">
                    {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
                </div>
            )}
        </div>
    );
}

export const Thinking = memo(ThinkingImpl);
