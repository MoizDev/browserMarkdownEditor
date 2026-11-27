import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { appendReply, createReplyView, destroyReplyView, setReplyText, setReplyTheme } from '../../editor/replyView';
import type { Theme } from '../../types';

export interface AssistantMessageProps {
    text: string;
    streaming: boolean;
    theme: Theme;
    scrollRoot: HTMLElement | null;
    initiallyNear: boolean;
}

export function AssistantMessage({ text, streaming, theme, scrollRoot, initiallyNear }: AssistantMessageProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const appliedRef = useRef('');
    const [near, setNear] = useState(initiallyNear);
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
