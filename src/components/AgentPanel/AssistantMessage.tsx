// One reply, drawn by a read-only CodeMirror view in the editor's Reading mode
// (editor/replyView.ts says why: no new innerHTML sink).
//
// Views are not free — each is a DOM tree, a parser and a decoration field —
// so only replies near the viewport hold one. Off-screen replies are plain
// text at their last measured height, and get their view back as they scroll
// near (IntersectionObserver, 800px ahead). The streaming reply always has one.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { appendReply, createReplyView, destroyReplyView, setReplyText, setReplyTheme } from '../../editor/replyView';
import type { Theme } from '../../types';

export interface AssistantMessageProps {
    text: string;
    streaming: boolean;
    theme: Theme;
    /** The scrolling message list, for the visibility observer. */
    scrollRoot: HTMLElement | null;
    /** Mount the view before the observer's first answer — the last few
     *  replies, which a list opened at its bottom shows at once (the others
     *  would flash from plain text to rendered). */
    initiallyNear: boolean;
}

export function AssistantMessage({ text, streaming, theme, scrollRoot, initiallyNear }: AssistantMessageProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    /** The text the view holds (or will, once its pending frame lands). */
    const appliedRef = useRef('');
    const [near, setNear] = useState(initiallyNear);
    /** Height to hold while unmounted, so scrolling past does not jump. */
    const [restHeight, setRestHeight] = useState<number | null>(null);
    const mounted = near || streaming;

    useEffect(() => {
        const el = wrapRef.current;
        if (!el || !scrollRoot) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) setRestHeight(el.offsetHeight);
            setNear(entry.isIntersecting);
        }, { root: scrollRoot, rootMargin: '800px 0px' });
        observer.observe(el);
        return () => observer.disconnect();
    }, [scrollRoot]);

    // Create on (re)mount with the text and theme of that moment; the two
    // effects below keep it current from then on.
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!mounted || !host) return;
        const view = createReplyView(host, text, theme);
        viewRef.current = view;
        appliedRef.current = text;
        return () => {
            destroyReplyView(view);
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mounted]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || appliedRef.current === text) return;
        const applied = appliedRef.current;
        // Streaming only ever extends the text; anything else is a rewrite.
        if (text.startsWith(applied)) appendReply(view, text.slice(applied.length));
        else setReplyText(view, text);
        appliedRef.current = text;
    }, [text]);

    useEffect(() => {
        if (viewRef.current) setReplyTheme(viewRef.current, theme);
    }, [theme]);

    return (
        <div
            ref={wrapRef}
            className="agent-reply"
            data-streaming={streaming ? '' : undefined}
            style={!mounted && restHeight ? { minHeight: restHeight } : undefined}
        >
            {mounted
                ? <div ref={hostRef} className="agent-reply-view" />
                : <div className="aic-prose agent-reply-plain">{text}</div>}
        </div>
    );
}
