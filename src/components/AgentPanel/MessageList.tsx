// The conversation: user messages, replies, thoughts, tool calls and notices,
// in order. It sticks to the bottom while a reply streams — unless the reader
// has scrolled up to read, which it then leaves alone.

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentHost } from '../../types/vaultAgent';
import type { Theme } from '../../types';
import type { ChatItem, Conversation, RunInfo } from './chatStore';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallCard } from './ToolCallCard';
import { UserMessage } from './UserMessage';
import { ThinkingReasoning } from './aicss/ThinkingReasoning';
import { ThinkingState } from './aicss/ThinkingState';
import { Orb } from './aicss/Orb';

/** Within this of the bottom counts as "at the bottom". */
const STICK_PX = 48;
/** Replies from the end that mount their view before the observer answers. */
const EAGER_REPLIES = 4;
/** The screen-reader mirror speaks new text in chunks this far apart. */
const LIVE_CHUNK_MS = 1500;

interface ItemProps {
    item: ChatItem;
    theme: Theme;
    host: AgentHost;
    scrollRoot: HTMLElement | null;
    eager: boolean;
}

/** Items are replaced (never mutated) when they change, so identity is the
 *  memo key: a streaming delta re-renders only the reply it extends. */
const Item = memo(function Item({ item, theme, host, scrollRoot, eager }: ItemProps) {
    switch (item.kind) {
        case 'user':
            return <UserMessage item={item} />;
        case 'assistant':
            return <AssistantMessage text={item.text} streaming={item.streaming} theme={theme} scrollRoot={scrollRoot} initiallyNear={eager} />;
        case 'reasoning':
            return (
                <ThinkingReasoning
                    text={item.text}
                    streaming={item.streaming}
                    durationMs={item.startedAt != null && item.endedAt != null ? item.endedAt - item.startedAt : null}
                />
            );
        case 'tool':
            return <ToolCallCard item={item} host={host} />;
        case 'notice':
            return <div className={'agent-notice ' + item.tone} role={item.tone === 'error' ? 'alert' : undefined}>{item.message}</div>;
    }
});

/**
 * A visually hidden `aria-live="polite"` mirror of the streaming reply. The
 * reply view itself is not a live region (a CodeMirror document changing per
 * frame would be read out as noise); this appends the new text in chunks, as
 * separate nodes, so a screen reader speaks each addition once.
 */
function LiveMirror({ text, streaming }: { text: string; streaming: boolean }) {
    const [chunks, setChunks] = useState<string[]>([]);
    const spoken = useRef(0);
    const latest = useRef(text);
    useEffect(() => { latest.current = text; });
    useEffect(() => {
        spoken.current = 0;
        setChunks([]);
    }, [streaming]);
    useEffect(() => {
        const flush = () => {
            const next = latest.current.slice(spoken.current);
            if (!next.trim()) return;
            spoken.current = latest.current.length;
            setChunks(c => [...c, next]);
        };
        if (!streaming) { flush(); return; }
        const id = window.setInterval(flush, LIVE_CHUNK_MS);
        return () => window.clearInterval(id);
    }, [streaming]);
    return (
        <div className="agent-sr-only" aria-live="polite" aria-atomic="false">
            {chunks.map((c, i) => <span key={i}>{c}</span>)}
        </div>
    );
}

export interface MessageListProps {
    conversation: Conversation;
    run: RunInfo | null;
    /** The run belongs to this conversation. */
    runHere: boolean;
    theme: Theme;
    host: AgentHost;
    onRetryHistory: () => void;
}

export function MessageList({ conversation, run, runHere, theme, host, onRetryHistory }: MessageListProps) {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const atBottom = useRef(true);
    const { items, history } = conversation;

    useLayoutEffect(() => {
        if (scroller && atBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });

    // A reply view grows after React is done with it (the view's own frame,
    // a KaTeX or mermaid render), so follow size changes too.
    useEffect(() => {
        if (!scroller) return;
        const inner = scroller.firstElementChild;
        if (!inner) return;
        const observer = new ResizeObserver(() => {
            if (atBottom.current) scroller.scrollTop = scroller.scrollHeight;
        });
        observer.observe(inner);
        return () => observer.disconnect();
    }, [scroller]);

    const onScroll = () => {
        if (!scroller) return;
        atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    };

    const last = items[items.length - 1];
    const lastIsLive = !!last && (
        (last.kind === 'assistant' && last.streaming)
        || (last.kind === 'reasoning' && last.streaming)
        || (last.kind === 'tool' && last.status === 'running')
    );
    const showThinking = runHere && run && !lastIsLive;
    let replies = 0;
    const eagerFrom = items.reduce((n, i) => n + (i.kind === 'assistant' ? 1 : 0), 0) - EAGER_REPLIES;
    const streamingReply = [...items].reverse().find(i => i.kind === 'assistant');

    return (
        <div className="agent-messages" ref={setScroller} onScroll={onScroll}>
            <div className="agent-messages-inner">
                {history === 'loading' && (
                    <div className="agent-empty"><Orb variant="S3" size={20} label="Loading" /> Loading this chat…</div>
                )}
                {history === 'missing' && (
                    <div className="agent-notice warning">
                        This chat was started on another computer — its history isn't available here. Start a new chat to continue.
                    </div>
                )}
                {history === 'error' && (
                    <div className="agent-notice error">
                        Couldn't load this chat. {conversation.historyError}{' '}
                        <button type="button" className="agent-link" onClick={onRetryHistory}>Retry</button>
                    </div>
                )}
                {items.length === 0 && history !== 'loading' && history !== 'missing' && history !== 'error' && (
                    <div className="agent-empty agent-welcome">
                        <p>Ask about what you're looking at — the agent sees your open tabs and exactly where you are in them.</p>
                        <p className="agent-muted">Its edits to this vault land in your editor and undo with ⌘Z. It runs with the same access to your computer as in your terminal, without asking first.</p>
                    </div>
                )}
                {items.map(item => {
                    const eager = item.kind === 'assistant' && replies++ >= eagerFrom;
                    return <Item key={item.id} item={item} theme={theme} host={host} scrollRoot={scroller} eager={eager} />;
                })}
                {showThinking && (
                    <div className="agent-thinking">
                        <Orb variant="S1" size={16} label="Working" />
                        <ThinkingState label={run.phase === 'stopping' ? 'Stopping' : run.phase === 'preparing' ? 'Reading your view' : 'Thinking'} />
                    </div>
                )}
            </div>
            {runHere && streamingReply?.kind === 'assistant' && (
                <LiveMirror key={streamingReply.id} text={streamingReply.text} streaming={streamingReply.streaming} />
            )}
        </div>
    );
}
