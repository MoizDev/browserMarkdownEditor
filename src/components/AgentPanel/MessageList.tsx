// The conversation: turns down one centred column —
// the user's bubble, then the agent's part on bare canvas (thinking, step
// stacks, change cards, the reply) and, under a finished reply, its action row.
//
// Scrolling. It sticks to the bottom while a reply streams, unless the reader
// scrolled up — then a "Jump to latest" pill offers the way back. Sending puts
// the new message at the TOP of the view: the turn it starts is given at least
// the view's height, so "the bottom" is exactly where the message sits at the
// top, and sticking to the bottom while the reply grows below needs no second
// rule. ⌘↑ / ⌘↓ step between turns — from the list, or from the composer
// through turnNav.ts.
//
// Rendering cost: items are replaced (never mutated) when they change, and
// every piece below is memoized on them, so a streamed token re-renders the
// reply it extends and the turn around it — not the conversation above.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { AgentHost } from '../../types/vaultAgent';
import type { Theme } from '../../types';
import type { ChatItem, Conversation, RunInfo } from './chatStore';
import { chatStore, reasoningDurationMs } from './chatStore';
import { versionOf } from '../../utils/chatTree';
import { subscribeEditRequest } from './editRequest';
import { subscribeTurnJump } from './turnNav';
import type { TurnJumpDir } from './turnNav';
import { AssistantMessage } from './AssistantMessage';
import { ChangeCard } from './ChangeCard';
import { ReplyActions } from './ReplyActions';
import { StepStack } from './StepStack';
import { Thinking } from './Thinking';
import { isCard, isCardChange } from './toolSteps';
import type { ToolItem } from './toolSteps';
import { UserMessage } from './UserMessage';
import { Shimmer } from './ui/Shimmer';
import { ArrowDown } from './ui/icons';

/** Scrolling DOWN to within this of the bottom sticks again. Never a reason
 *  to keep sticking: any upward scroll lets go (`onScroll` says why). */
const STICK_PX = 48;
/** Turns from the end whose replies mount their view before the observer
 *  answers (a list opened at its bottom shows them at once). */
const EAGER_TURNS = 4;
/** ⌘↑/⌘↓'s own scroll, and how long after it the turn is kept at the top
 *  while the views it brought into range mount. */
const NAV_MS = 360;
const NAV_HOLD_MS = 500;
/** Keys that scroll the list (besides the arrows): any of them ends a jump. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ']);
/** The screen-reader mirror speaks new text in chunks this far apart. */
const LIVE_CHUNK_MS = 1500;

type UserItem = Extract<ChatItem, { kind: 'user' }>;
type NoticeItem = Extract<ChatItem, { kind: 'notice' }>;

/** Stable for the app's life, so the memoized rows below never see a new
 *  function: the store owns the tree, a row only says what the user did. */
const editMessage = (id: string, text: string) => chatStore.editMessage(id, text);
const selectVersion = (id: string, index: number) => chatStore.selectVersionAt(id, index);

/** Out of the component on purpose: the element is React state (the reply
 *  views' observer root), which the compiler's lint will not let a render
 *  scope assign to — but scrolling it is exactly what the list is for. */
function toBottom(el: HTMLElement): number {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
}

function scrollTo(el: HTMLElement, top: number): number {
    el.scrollTop = top;
    return el.scrollTop;
}

/** Follow the stream: pin to the bottom — unless the READER moved the list
 *  up since it last looked (`lastTop`). False = the reader has it: let go.
 *  Checked HERE and not only in `onScroll` because a scroll event comes a
 *  frame late, and the pin of the frame in between overwrote what the reader
 *  did before it could be seen (measured: a 30px scrollbar-style drag and the
 *  first 29px of an ↑ key's smooth scroll lost to it).
 *  `reader` is false when a move up cannot be the reader's (MessageList's
 *  `readerMayHaveMoved`: no hand on the list just after the list moved
 *  itself): then it is the browser clamping scrollTop because the content
 *  shrank under it — re-pinned, never a release. Measured on a chat restored
 *  by a reload: the commit that swaps "Loading this chat…" for the turns pins
 *  to 573, the content collapses below the view for a moment in the same task
 *  (reply views mounting), scrollTop is clamped to 0, and reading that as the
 *  reader left 1 restore in 2 at the TOP of the chat. `movedAt` records when
 *  a pin last moved the list. */
function pin(el: HTMLElement, lastTop: { current: number }, reader: boolean, movedAt: { current: number }): boolean {
    const top = el.scrollTop;
    if (reader && top < lastTop.current - 1 && el.scrollHeight - el.clientHeight - top > 1) return false;
    lastTop.current = toBottom(el);
    if (Math.abs(lastTop.current - top) > 1) movedAt.current = performance.now();
    return true;
}

/** How long one gesture event (a wheel notch, a touch, a key) counts as the
 *  reader's hand on the list; each scroll event while it does extends it, so
 *  a fling's momentum and a key's smooth scroll stay the reader's to the end. */
const INTENT_MS = 600;
const INTENT_TAIL_MS = 250;
/** How long after the list moved itself an unexplained move up is still read
 *  as the clamp of that move's content change. Past it, a move up with no
 *  gesture seen (find in page, a screen reader, a script's scrollIntoView)
 *  is the reader's, as it always was. */
const CLAMP_MS = 400;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ───────────────────────── turns ───────────────────────── */

interface Turn {
    /** The user message's id, or "lead" for anything before the first one. */
    key: string;
    user: UserItem | null;
    /** What came after it, in order. */
    rest: ChatItem[];
}

function groupTurns(items: ChatItem[]): Turn[] {
    const turns: Turn[] = [];
    let current: Turn | null = null;
    for (const item of items) {
        if (item.kind === 'user') {
            current = { key: item.id, user: item, rest: [] };
            turns.push(current);
        } else {
            if (!current) {
                current = { key: 'lead', user: null, rest: [] };
                turns.push(current);
            }
            current.rest.push(item);
        }
    }
    return turns;
}

type Block =
    | { kind: 'steps'; key: string; items: ToolItem[] }
    | { kind: 'card'; key: string; item: ToolItem }
    | { kind: 'item'; key: string; item: Exclude<ChatItem, { kind: 'user' }> };

/** Consecutive tool steps share one stack; a landed edit breaks out of it as
 *  a change card, in the place it happened. */
function blocksOf(rest: ChatItem[]): Block[] {
    const blocks: Block[] = [];
    for (const item of rest) {
        if (item.kind === 'user') continue;
        if (item.kind === 'tool') {
            if (isCardChange(item)) { blocks.push({ kind: 'card', key: item.id, item }); continue; }
            const last = blocks[blocks.length - 1];
            if (last?.kind === 'steps') last.items.push(item);
            else blocks.push({ kind: 'steps', key: item.id, items: [item] });
            continue;
        }
        blocks.push({ kind: 'item', key: item.id, item });
    }
    return blocks;
}

/** A notice's first sentence is its key: drawn a step brighter (red for an
 *  error) than the rest of the line. */
function splitKey(message: string): [string, string] {
    const m = /^(.+?[.!?:])(?:\s+([\s\S]*))?$/.exec(message);
    return m ? [m[1], m[2] ?? ''] : [message, ''];
}

function Notice({ item }: { item: NoticeItem }) {
    // The run's own end: one quiet word under what it got to say.
    if (item.tone === 'info' && item.message === 'Stopped.') return <div className="va-stopped">Stopped.</div>;
    if (item.tone === 'info') return <div className="va-notice">{item.message}</div>;
    const [key, rest] = splitKey(item.message);
    return (
        <div className={'va-notice is-' + item.tone} role={item.tone === 'error' ? 'alert' : undefined}>
            <b>{key}</b>{rest && ' ' + rest}
        </div>
    );
}

interface TurnProps {
    turn: Turn;
    theme: Theme;
    host: AgentHost;
    scrollRoot: HTMLElement | null;
    eager: boolean;
    versionIndex: number;
    versionCount: number;
    canEdit: boolean;
    editNonce: number;
    /** The run answering this turn is live. */
    live: boolean;
    /** The live label while nothing streams yet ("Thinking…"), else null. */
    liveLabel: string | null;
    /** The newest turn: its action row is always visible. */
    latest: boolean;
    /** A run is live anywhere: retry waits. */
    busy: boolean;
    /** Sending pinned this turn to the top of the view. */
    pinned: boolean;
}

function TurnImpl({ turn, theme, host, scrollRoot, eager, versionIndex, versionCount, canEdit, editNonce, live, liveLabel, latest, busy, pinned }: TurnProps) {
    const blocks = blocksOf(turn.rest);
    let text = '';
    let modelId: string | null = null;
    for (const item of turn.rest) {
        if (item.kind === 'assistant' && item.text.trim()) {
            text += (text ? '\n\n' : '') + item.text.trim();
            if ('model' in item && typeof item.model === 'string') modelId = item.model;
        }
    }
    if (!text) {
        const failed = turn.rest.find((i): i is NoticeItem => i.kind === 'notice' && i.tone === 'error');
        if (failed) text = failed.message;
    }
    const showActions = !live && !!text;

    const parts: ReactNode[] = blocks.map(block => {
        if (block.kind === 'steps') return <StepStack key={block.key} items={block.items} />;
        if (block.kind === 'card') {
            const change = block.item.change;
            return isCard(change) ? <ChangeCard key={block.key} change={change} host={host} /> : null;
        }
        const item = block.item;
        switch (item.kind) {
            case 'assistant':
                return <AssistantMessage key={item.id} text={item.text} streaming={item.streaming} theme={theme} scrollRoot={scrollRoot} initiallyNear={eager} />;
            case 'reasoning':
                return <Thinking key={item.id} text={item.text} live={item.streaming} durationMs={reasoningDurationMs(item)} />;
            case 'notice':
                return <Notice key={item.id} item={item} />;
            default:
                return null;
        }
    });

    return (
        <div className={'va-turn' + (pinned ? ' is-pinned' : '')} data-turn={turn.key}>
            {turn.user && (
                <UserMessage
                    item={turn.user}
                    versionIndex={versionIndex}
                    versionCount={versionCount}
                    canEdit={canEdit}
                    onEdit={editMessage}
                    onVersion={selectVersion}
                    editNonce={editNonce}
                />
            )}
            {(parts.length > 0 || liveLabel) && (
                <div className="va-a">
                    {parts}
                    {liveLabel && <Thinking text="" live label={liveLabel} />}
                    {showActions && (
                        <ReplyActions
                            text={text}
                            userNodeId={turn.user?.id ?? null}
                            modelId={modelId}
                            latest={latest}
                            busy={busy}
                            theme={theme}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/** The list hands over a fresh Turn on every render; equal members = the
 *  same turn. Without this every token re-rendered every turn above it. */
const TurnView = memo(TurnImpl, (a, b) => {
    for (const key of Object.keys(a) as (keyof TurnProps)[]) {
        if (key === 'turn') continue;
        if (a[key] !== b[key]) return false;
    }
    const x = a.turn, y = b.turn;
    return x.key === y.key && x.user === y.user && x.rest.length === y.rest.length && x.rest.every((item, i) => item === y.rest[i]);
});

/* ───────────────────────── the screen-reader mirror ───────────────────────── */

/**
 * A visually hidden `aria-live="polite"` mirror of the streaming reply. The
 * reply view itself is not a live region (a CodeMirror document changing per
 * frame would be read out as noise); this appends the new text in chunks, as
 * separate nodes, so a screen reader speaks each addition once.
 *
 * It outlives the run (the list keeps it on the latest reply): the run ends
 * before the last chunk is due, and a mirror unmounted with the run never
 * spoke the reply's end (measured: 5,184 of 5,720 characters). Ending only
 * flushes what is left — never a reset, which re-spoke the whole reply — and
 * a reply that was never seen streaming (a chat opened from history) says
 * nothing.
 */
function LiveMirror({ text, streaming }: { text: string; streaming: boolean }) {
    const [chunks, setChunks] = useState<string[]>([]);
    const spoken = useRef(0);
    const latest = useRef(text);
    const heard = useRef(streaming);
    useEffect(() => { latest.current = text; });
    useEffect(() => {
        const flush = () => {
            const next = latest.current.slice(spoken.current);
            if (!next.trim()) return;
            spoken.current = latest.current.length;
            setChunks(c => [...c, next]);
        };
        if (!streaming) {
            if (heard.current) flush();
            return;
        }
        heard.current = true;
        const id = window.setInterval(flush, LIVE_CHUNK_MS);
        return () => window.clearInterval(id);
    }, [streaming]);
    return (
        <div className="agent-sr-only" aria-live="polite" aria-atomic="false">
            {chunks.map((c, i) => <span key={i}>{c}</span>)}
        </div>
    );
}

/* ───────────────────────── the list ───────────────────────── */

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
    /** A scroll the list started itself (a smooth one passes through "not at
     *  the bottom" on its way there, which must not read as the reader's). */
    const autoScrolling = useRef(false);
    /** Where the list last saw itself: its own last write, or the last scroll
     *  event. A scroll event above it is a reader going up — when a reader is
     *  there (`readerActive`). */
    const lastTop = useRef(0);
    /** The reader's hand: until when the last wheel / touch / key / focus in
     *  the list counts, and whether a pointer (a scrollbar drag) is down. */
    const intentUntil = useRef(0);
    const dragging = useRef(false);
    /** When a pin last moved the list. */
    const pinMovedAt = useRef(0);
    const [showJump, setShowJump] = useState(false);
    const readerActive = useCallback(() => dragging.current || performance.now() < intentUntil.current, []);
    const readerMayHaveMoved = useCallback(
        () => readerActive() || performance.now() - pinMovedAt.current > CLAMP_MS, [readerActive]);
    /** The header's hairline (header.css) reads this as `data-scrolled`. */
    const [scrolled, setScrolled] = useState(false);
    const [viewHeight, setViewHeight] = useState(0);
    /** The turn sending pinned to the top of the view. */
    const [pinned, setPinned] = useState<string | null>(null);
    /** The turn ⌘↑/⌘↓ is taking the view to, until it is there: a second
     *  press steps from IT, not from wherever the smooth scroll has got to
     *  (measured: from the mid-animation scrollTop, 1 press in 5 landed). */
    const navTarget = useRef<string | null>(null);
    /** ⌘↓ past the last turn is on its way to the bottom: a further ⌘↓ has
     *  nothing to add, and ⌘↑ steps back from the end, not from mid-scroll. */
    const navBottom = useRef(false);
    const [editTarget, setEditTarget] = useState<{ id: string; nonce: number }>({ id: '', nonce: 0 });
    const { items, history } = conversation;

    const turns = groupTurns(items);
    const lastUser = [...turns].reverse().find(t => t.user)?.user ?? null;
    const lastUserId = lastUser?.id ?? null;

    // The edit request (↑ in an empty composer) reads the newest values at the
    // moment it arrives, not those of the render that subscribed.
    const latestRef = useRef({ lastUserId, running: !!run, tree: conversation.tree });
    useEffect(() => { latestRef.current = { lastUserId, running: !!run, tree: conversation.tree }; });
    useEffect(() => subscribeEditRequest(() => {
        const { lastUserId: id, running, tree } = latestRef.current;
        if (!id || running || !tree.nodes[id]) return;
        setEditTarget(t => ({ id, nonce: t.nonce + 1 }));
    }), []);

    const scrollToBottom = useCallback((smooth: boolean) => {
        if (!scroller) return;
        atBottom.current = true;
        setShowJump(false);
        const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        if (smooth && !reducedMotion() && distance > 1) {
            // Cleared by `scrollend` — or by this, since a smooth scroll the
            // reply's growth interrupts ends without one, and a flag left set
            // stops the list following for good.
            autoScrolling.current = true;
            window.setTimeout(() => { autoScrolling.current = false; }, 700);
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        } else {
            lastTop.current = toBottom(scroller);
        }
    }, [scroller]);

    // ⌘↑ / ⌘↓: the previous / next turn's top. The browser's smooth scroll
    // aims at a NUMBER, and the replies it passes mount their views on the
    // way (plain text → rendered, a different height), moving the turn it
    // aimed at: measured, ⌘↑ landed 636px inside the turn above, and chasing
    // the turn with a fresh smooth scroll on every resize took a second to
    // land. So the list animates itself: NAV_MS of ease-out whose end is read
    // from the turn's live position every frame, then a short hold in which
    // views that mount late are absorbed by the observer (`settleNav`).
    const navFrame = useRef(0);
    const navTop = useCallback((): number | null => {
        const key = navTarget.current;
        const row = key && scroller
            ? scroller.querySelector<HTMLElement>(`.va-turn[data-turn="${CSS.escape(key)}"]`)
            : null;
        if (!scroller || !row) return null;
        const max = scroller.scrollHeight - scroller.clientHeight;
        return Math.max(0, Math.min(max, scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 6));
    }, [scroller]);
    const endNav = useCallback(() => {
        cancelAnimationFrame(navFrame.current);
        navFrame.current = 0;
        navTarget.current = null;
        autoScrolling.current = false;
    }, []);
    /** Put the target turn exactly at the top now (a hold, or reduced motion). */
    const settleNav = useCallback(() => {
        const top = navTop();
        if (top === null) { endNav(); return; }
        if (scroller && Math.abs(top - scroller.scrollTop) >= 1) lastTop.current = scrollTo(scroller, top);
    }, [scroller, navTop, endNav]);
    const startNav = useCallback(() => {
        if (!scroller) return;
        cancelAnimationFrame(navFrame.current);
        const key = navTarget.current;
        const hold = () => {
            navFrame.current = 0;
            autoScrolling.current = false;
            window.setTimeout(() => { if (navTarget.current === key && !navFrame.current) navTarget.current = null; }, NAV_HOLD_MS);
        };
        if (reducedMotion()) { settleNav(); hold(); return; }
        const from = scroller.scrollTop;
        const start = performance.now();
        autoScrolling.current = true;
        const step = () => {
            if (navTarget.current !== key) return;
            const to = navTop();
            if (to === null) { endNav(); return; }
            const t = Math.min(1, (performance.now() - start) / NAV_MS);
            const eased = 1 - (1 - t) ** 3;
            lastTop.current = scrollTo(scroller, from + (to - from) * eased);
            if (t < 1) navFrame.current = requestAnimationFrame(step);
            else hold();
        };
        navFrame.current = requestAnimationFrame(step);
    }, [scroller, navTop, settleNav, endNav]);


    // A new message at the end while this chat's run is starting = the user
    // just sent (or edited) it: pin its turn and bring it to the top.
    const prevLastUser = useRef(lastUserId);
    useLayoutEffect(() => {
        if (lastUserId === prevLastUser.current) return;
        prevLastUser.current = lastUserId;
        setPinned(runHere && lastUserId ? lastUserId : null);
    }, [lastUserId, runHere]);
    // The target is the new row's own top, measured after layout — never the
    // scroll height, which moves as rows above re-measure. The pinned turn's
    // min-height is what guarantees the room to scroll that far.
    useLayoutEffect(() => {
        if (!pinned || !scroller) return;
        const row = scroller.querySelector<HTMLElement>(`.va-turn[data-turn="${CSS.escape(pinned)}"]`);
        if (!row) return;
        atBottom.current = true;
        setShowJump(false);
        const top = row.offsetTop - 6;
        if (reducedMotion() || Math.abs(top - scroller.scrollTop) < 2) { lastTop.current = scrollTo(scroller, top); return; }
        autoScrolling.current = true;
        window.setTimeout(() => { autoScrolling.current = false; }, 700);
        scroller.scrollTo({ top, behavior: 'smooth' });
    }, [pinned, scroller]);

    // A refused pin only lets go: the reader's move fires its scroll event a
    // frame later, still above `lastTop`, and that shows the pill.
    useLayoutEffect(() => {
        if (scroller && atBottom.current && !autoScrolling.current && !pin(scroller, lastTop, readerMayHaveMoved(), pinMovedAt)) atBottom.current = false;
    });

    // A reply view grows after React is done with it (the view's own frame,
    // a KaTeX or mermaid render), so follow size changes too; and the view's
    // height is what a pinned turn is sized against.
    useEffect(() => {
        if (!scroller) return;
        const inner = scroller.firstElementChild;
        const observer = new ResizeObserver(() => {
            setViewHeight(scroller.clientHeight);
            if (navTarget.current) { if (!navFrame.current) settleNav(); return; }
            if (atBottom.current && !autoScrolling.current && !pin(scroller, lastTop, readerMayHaveMoved(), pinMovedAt)) atBottom.current = false;
        });
        observer.observe(scroller);
        if (inner) observer.observe(inner);
        const onScrollEnd = () => {
            autoScrolling.current = false;
            navBottom.current = false;
            // A smooth scroll to the bottom aims at the scrollHeight of its
            // start, and the replies it passes grow as their views mount
            // (measured: Jump to latest / ⌘↓ stopped 642px short).
            if (!navTarget.current && atBottom.current && !pin(scroller, lastTop, readerMayHaveMoved(), pinMovedAt)) atBottom.current = false;
        };
        // The reader's own hand: it ends a jump in flight, and makes the next
        // upward moves theirs (see `pin`).
        const hand = () => {
            endNav();
            navBottom.current = false;
            intentUntil.current = performance.now() + INTENT_MS;
        };
        const press = () => { hand(); dragging.current = true; };
        const release = () => { if (dragging.current) { dragging.current = false; intentUntil.current = performance.now() + INTENT_MS; } };
        // Keys and focus only mark the hand (a ⌘↑ jump must keep its target);
        // onKeyDown ends a jump for the keys that scroll.
        const mark = () => { intentUntil.current = performance.now() + INTENT_MS; };
        // A reply is a read-only CodeMirror view: its mousedown handler cancels
        // the default (it draws the selection itself) and blurs what had the
        // keyboard, while its content cannot take focus — measured, a click on
        // reply prose left <body> focused, so Esc and ⌘↑/⌘↓ went nowhere. This
        // runs after it (bubbling) and gives the keyboard to the list, as a
        // click on blank space does. Only when it fell to <body>: a button or
        // the edit box that took it keeps it, and a drag still selects.
        const keepKeyboard = () => {
            const active = document.activeElement;
            if (!active || active === document.body) scroller.focus({ preventScroll: true });
        };
        scroller.addEventListener('scrollend', onScrollEnd);
        scroller.addEventListener('mousedown', keepKeyboard);
        scroller.addEventListener('wheel', hand, { passive: true });
        scroller.addEventListener('touchstart', hand, { passive: true });
        scroller.addEventListener('touchmove', hand, { passive: true });
        scroller.addEventListener('pointerdown', press);
        scroller.addEventListener('keydown', mark);
        scroller.addEventListener('focusin', mark);
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        return () => {
            observer.disconnect();
            scroller.removeEventListener('scrollend', onScrollEnd);
            scroller.removeEventListener('mousedown', keepKeyboard);
            scroller.removeEventListener('wheel', hand);
            scroller.removeEventListener('touchstart', hand);
            scroller.removeEventListener('touchmove', hand);
            scroller.removeEventListener('pointerdown', press);
            scroller.removeEventListener('keydown', mark);
            scroller.removeEventListener('focusin', mark);
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', release);
        };
    }, [scroller, settleNav, endNav, readerMayHaveMoved]);

    // Let go on the DIRECTION of a scroll, never on its distance from the
    // bottom. "Within 48px of the bottom = still at the bottom" read a reader's
    // first small step up as staying put, and the next frame's pin (the layout
    // effect / observer above, once per streamed frame) put them back: measured
    // mid-stream on 6aebf34 and ad76b19 alike, a 3×10px trackpad nudge, 30
    // trackpad events of 3–8px (163px), a 300px touch swipe, one ↑ key (40px)
    // and a 30px scrollbar drag each moved the list 15px at most — it kept
    // following the reply — and only gestures over 48px in ONE frame (wheel
    // notches) escaped.
    // The list itself only ever scrolls down (pins, Jump to latest, a pinned
    // turn), so a scroll event above where it last was is the reader, whatever
    // the input (wheel, touch, keys, scrollbar), and lets go at once. A clamp
    // (the content shrank under a pinned list) also moves up, but lands AT the
    // bottom, which is checked first.
    const onScroll = () => {
        if (!scroller) return;
        const top = scroller.scrollTop;
        const reader = readerMayHaveMoved();
        if (readerActive()) intentUntil.current = Math.max(intentUntil.current, performance.now() + INTENT_TAIL_MS);
        const movedUp = top < lastTop.current - 1;
        const movedDown = top > lastTop.current;
        lastTop.current = top;
        setScrolled(top > 2);
        const distance = scroller.scrollHeight - top - scroller.clientHeight;
        if (distance <= 1) {
            atBottom.current = true;
        } else if (movedUp && !reader && atBottom.current && !autoScrolling.current) {
            // A clamp, not the reader (`pin` says how it happens): back down.
            lastTop.current = toBottom(scroller);
            pinMovedAt.current = performance.now();
            setScrolled(lastTop.current > 2);
            return;
        } else if (movedUp) {
            // Also ends a smooth scroll of ours the reader overrode.
            atBottom.current = false;
            autoScrolling.current = false;
        } else if (autoScrolling.current) {
            return;
        } else if (movedDown && distance < STICK_PX) {
            atBottom.current = true;
        }
        setShowJump(!atBottom.current);
    };

    const jumpTurn = useCallback((dir: TurnJumpDir) => {
        if (!scroller) return;
        const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.va-turn'));
        if (navBottom.current && dir > 0) return;
        const pending = navBottom.current ? rows.length
            : navTarget.current ? rows.findIndex(r => r.dataset.turn === navTarget.current) : -1;
        navBottom.current = false;
        let index: number;
        if (pending >= 0) {
            index = pending + dir;
        } else {
            const top = scroller.getBoundingClientRect().top;
            const offsets = rows.map(el => el.getBoundingClientRect().top - top);
            index = dir < 0 ? offsets.filter(o => o < -4).length - 1 : offsets.findIndex(o => o > 8);
        }
        if (index < 0 && dir < 0) return;
        if (index < 0 || index >= rows.length) {
            endNav();
            scrollToBottom(true);
            navBottom.current = autoScrolling.current;
            return;
        }
        navTarget.current = rows[index].dataset.turn ?? null;
        // Not following the reply while the reader goes back through it;
        // arriving at the very bottom sticks again (onScroll).
        atBottom.current = false;
        startNav();
    }, [scroller, startNav, endNav, scrollToBottom]);

    // The composer's ⌘↑/⌘↓ (the keyboard is nearly always there) arrive
    // through turnNav.ts.
    const jumpRef = useRef(jumpTurn);
    useEffect(() => { jumpRef.current = jumpTurn; });
    useEffect(() => subscribeTurnJump(dir => jumpRef.current(dir)), []);

    // The list's own: an edit field inside it keeps its own arrows. Any other
    // key that scrolls is the reader taking over from a jump in flight.
    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown';
        const nav = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && arrow;
        if (!nav) {
            // (The ⌘ of ⌘↑ arrives first, on its own: not a scroll.)
            if (arrow || SCROLL_KEYS.has(e.key)) { endNav(); navBottom.current = false; }
            return;
        }
        if ((e.target as HTMLElement).closest('textarea, input')) return;
        e.preventDefault();
        jumpTurn(e.key === 'ArrowUp' ? -1 : 1);
    };

    const last = items[items.length - 1];
    const lastIsLive = !!last && (
        (last.kind === 'assistant' && last.streaming)
        || (last.kind === 'reasoning' && last.streaming)
        || (last.kind === 'tool' && last.status === 'running')
    );
    // "Stopping…" whatever was streaming when Stop was pressed: the stop can
    // take seconds to land (the CLI finishes its step), and a disabled button
    // alone did not say it had been heard. The other labels stand in for a
    // stream that has not started.
    const liveLabel = !runHere || !run ? null
        : run.phase === 'stopping' ? 'Stopping…'
            : lastIsLive ? null
                : run.phase === 'preparing' ? 'Reading your view…' : 'Thinking…';
    const streamingReply = [...items].reverse().find(i => i.kind === 'assistant');
    const historyNotice = history === 'loading' || history === 'missing' || history === 'error';

    // The empty conversation belongs to the panel (its greeting and composer).
    if (!items.length && !historyNotice) return null;

    return (
        <div className="va-conversation" data-scrolled={scrolled ? '' : undefined} style={{ ['--va-view-h' as string]: `${viewHeight}px` }}>
            <div
                className="agent-messages"
                ref={setScroller}
                onScroll={onScroll}
                onKeyDown={onKeyDown}
                tabIndex={0}
                // A region, not a log: a log is a live region, and a reply's
                // CodeMirror document changing per frame would be read out as
                // noise — LiveMirror below speaks the new text instead.
                role="region"
                aria-label="Conversation"
            >
                <div className="agent-messages-inner va-col">
                    {history === 'loading' && (
                        <div className="va-notice" role="status"><Shimmer>Loading this chat…</Shimmer></div>
                    )}
                    {history === 'missing' && (
                        <div className="va-notice is-warning">
                            <b>This chat's history isn't on this computer.</b> It was started on another one; start a new chat to continue.
                        </div>
                    )}
                    {history === 'error' && (
                        <div className="va-notice is-error" role="alert">
                            <b>Couldn't load this chat.</b> {conversation.historyError}{' '}
                            <button type="button" className="va-text-btn" onClick={onRetryHistory}>Try again</button>
                        </div>
                    )}
                    {turns.map((turn, i) => {
                        const isLast = i === turns.length - 1;
                        const live = isLast && runHere && !!run;
                        const version = turn.user ? versionOf(conversation.tree, turn.user.id) : undefined;
                        return (
                            <TurnView
                                key={turn.key}
                                turn={turn}
                                theme={theme}
                                host={host}
                                scrollRoot={scroller}
                                eager={i >= turns.length - EAGER_TURNS}
                                versionIndex={version?.index ?? 0}
                                versionCount={version?.count ?? 1}
                                canEdit={!!turn.user && !run && !!conversation.tree.nodes[turn.user.id]}
                                editNonce={turn.user && editTarget.id === turn.user.id ? editTarget.nonce : 0}
                                live={live}
                                liveLabel={live ? liveLabel : null}
                                latest={isLast}
                                busy={!!run}
                                pinned={pinned === turn.key}
                            />
                        );
                    })}
                </div>
            </div>
            <button
                type="button"
                className={'va-jump' + (showJump && runHere ? ' is-shown' : '')}
                tabIndex={showJump && runHere ? 0 : -1}
                aria-hidden={showJump && runHere ? undefined : true}
                onClick={() => scrollToBottom(true)}
            >
                <ArrowDown aria-hidden="true" />
                Jump to latest
            </button>
            {streamingReply?.kind === 'assistant' && (
                <LiveMirror key={streamingReply.id} text={streamingReply.text} streaming={streamingReply.streaming} />
            )}
        </div>
    );
}
