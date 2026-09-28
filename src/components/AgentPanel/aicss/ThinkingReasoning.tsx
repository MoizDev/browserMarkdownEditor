// Adapted from AICSS's ThinkingReasoning (MIT, © 2026 AICSS — see
// LICENSE-aicss; https://www.aicss.dev/components/thinking-reasoning).
//
// Changed: the original replays six canned sentences on a timer; this one
// shows the agent's REAL reasoning as it streams. While streaming the viewport
// follows the newest text behind the soft top fade; once done it folds into
// "Thought for Ns" and unfolds on click into a scrollable, faded viewport —
// the same two phases and motion as the original. Paragraphs replace the
// fixed two-line sentence rows, since real reasoning has no fixed length.

import { useLayoutEffect, useRef, useState } from 'react';

const MAX_H = 180;
const FADE = 16;

interface Fade { top: boolean; bottom: boolean }

function fadeOf(el: HTMLElement): Fade {
    return { top: el.scrollTop > 1, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1 };
}

function sameFade(prev: Fade, next: Fade): Fade {
    return prev.top === next.top && prev.bottom === next.bottom ? prev : next;
}

export interface ThinkingReasoningProps {
    text: string;
    streaming: boolean;
    /** How long the agent thought, when known (not for history). */
    durationMs: number | null;
}

export function ThinkingReasoning({ text, streaming, durationMs }: ThinkingReasoningProps) {
    const [open, setOpen] = useState(false);
    const [fade, setFade] = useState<Fade>({ top: false, bottom: false });
    const viewportRef = useRef<HTMLDivElement>(null);
    const expanded = streaming || open;

    const measureFade = () => {
        const el = viewportRef.current;
        if (el) setFade(prev => sameFade(prev, fadeOf(el)));
    };

    useLayoutEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        if (streaming) el.scrollTop = el.scrollHeight;
        setFade(prev => sameFade(prev, fadeOf(el)));
    }, [text, streaming, open]);

    const toggle = () => {
        const next = !open;
        if (next && viewportRef.current) viewportRef.current.scrollTop = 0;
        setOpen(next);
    };

    const mask = fade.top || fade.bottom
        ? `linear-gradient(to bottom, transparent 0, #000 ${fade.top ? FADE : 0}px, #000 calc(100% - ${fade.bottom ? FADE : 0}px), transparent 100%)`
        : 'none';
    const seconds = durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : null;
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    return (
        <div className="aic-tr">
            <button
                type="button"
                className={'aic-tr-header' + (streaming ? '' : ' is-clickable')}
                aria-expanded={expanded}
                onClick={streaming ? undefined : toggle}
            >
                {streaming ? (
                    <span className="aic-tr-label aic-shimmer">Thinking…</span>
                ) : (
                    <span className="aic-tr-label">
                        <span className="aic-tr-verb">Thought</span>{seconds != null ? ` for ${seconds}s` : ''}
                    </span>
                )}
                {!streaming && (
                    <svg className="aic-tr-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                        <path d="m4.5 15.75 7.5-7.5 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                )}
            </button>
            <div className={'aic-tr-collapsible' + (expanded ? '' : ' is-collapsed')}>
                <div className="aic-tr-inner">
                    <div
                        ref={viewportRef}
                        className={'aic-tr-viewport' + (streaming ? '' : ' is-scroll')}
                        style={{ maxHeight: MAX_H, WebkitMaskImage: mask, maskImage: mask }}
                        onScroll={measureFade}
                    >
                        {paragraphs.map((p, i) => <p key={i} className="aic-tr-sentence">{p}</p>)}
                    </div>
                </div>
            </div>
        </div>
    );
}
