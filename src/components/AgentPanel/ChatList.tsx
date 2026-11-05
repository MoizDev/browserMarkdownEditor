// The header's history button and its menu: this vault's chats (from
// .VaultAgent/chats.json), grouped as recents — Starred, then
// Today / Yesterday / Earlier by when each was last used — under a "Search
// chats" field that is always there and has the keyboard as it opens
// (shown only past eight chats, the field was missing from the
// menu people first meet). Enter in it opens the first match. Each row is the
// title over "Agent · when" ("replying…" for the one running), ✓ on the open
// chat, and a ⋯ on the hovered or focused row for Star / Rename / Delete
// (TitleMenu's ChatActions, shown in this same popover), reached by → or Tab
// from its row. New chat is the header's own button.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { AGENT_LABELS } from '../../../shared/vaultAgentProtocol';
import type { ChatMeta } from '../../types/vaultAgent';
import type { Theme } from '../../types';
import { History, MoreHorizontal, Search } from './ui/icons';
import { IconButton } from './ui/IconButton';
import { MenuRow, MenuSection } from './ui/MenuRow';
import { Popover } from './Popover';
import { ChatActions } from './TitleMenu';
import type { Notify } from './TitleMenu';
import { activeChatOf, chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "just now" / "12 min ago" / "4 h ago" / "yesterday" / "28 Oct". */
function when(ms: number, now: number): string {
    const min = Math.round((now - ms) / 60_000);
    const today = startOfDay(now);
    if (ms >= today) {
        if (min < 1) return 'just now';
        if (min < 60) return `${min} min ago`;
        return `${Math.round(min / 60)} h ago`;
    }
    if (ms >= today - DAY_MS) return 'yesterday';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

type Group = { label: string; chats: ChatMeta[] };

function groups(chats: ChatMeta[], now: number): Group[] {
    const today = startOfDay(now);
    const out: Group[] = [
        { label: 'Starred', chats: [] },
        { label: 'Today', chats: [] },
        { label: 'Yesterday', chats: [] },
        { label: 'Earlier', chats: [] },
    ];
    for (const chat of chats) {
        const g = chat.starred ? 0 : chat.updatedAt >= today ? 1 : chat.updatedAt >= today - DAY_MS ? 2 : 3;
        out[g].chats.push(chat);
    }
    return out.filter(g => g.chats.length);
}

function ChatsBody({ state, onClose, notify }: { state: ChatStoreState; onClose: () => void; notify: Notify }) {
    const [query, setQuery] = useState('');
    const [actionsFor, setActionsFor] = useState<string | null>(null);
    const search = useRef<HTMLInputElement>(null);
    const activeId = activeChatOf(state)?.id ?? null;
    const busyChat = state.run?.chatId;
    // Read once per open: the relative times need not tick while it is up.
    const [now] = useState(Date.now);

    // A passive effect, after Popover's focus-on-open: typing to find a chat
    // is what the menu is opened for.
    useEffect(() => { search.current?.focus({ preventScroll: true }); }, []);

    const actionChat = actionsFor ? state.chats.find(c => c.id === actionsFor) : null;
    if (actionChat) return <ChatActions chat={actionChat} onDone={onClose} notify={notify} heading />;

    const q = query.trim().toLowerCase();
    const shown = q ? state.chats.filter(c => c.title.toLowerCase().includes(q)) : state.chats;
    const grouped = groups(shown, now);
    const open = (id: string) => { onClose(); chatStore.openChat(id); };

    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
        // Home/End belong to the field, not to the menu's row-to-row keys.
        if (e.key === 'Home' || e.key === 'End') e.stopPropagation();
        // The top row, as listed (Starred first): what the search narrowed to.
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && q && grouped.length) {
            e.preventDefault();
            open(grouped[0].chats[0].id);
        }
    };
    // → from a row to its ⋯, ← back: the pair is one line, and ↑/↓ walk rows.
    const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const to = e.currentTarget.querySelector<HTMLElement>(e.key === 'ArrowRight' ? '.agent-chat-more' : '.va-menu-row');
        if (!to || to === e.target) return;
        e.preventDefault();
        to.focus();
    };

    return (
        <>
            <label className="agent-pop-search">
                <Search aria-hidden="true" />
                <input
                    ref={search}
                    value={query}
                    placeholder="Search chats"
                    aria-label="Search chats"
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                />
            </label>
            {state.indexStatus === 'loading' && !state.chats.length && <div className="agent-pop-hint">Loading…</div>}
            {state.indexStatus === 'error' && <div className="agent-pop-hint">Couldn't read this vault's chats. {state.indexError}</div>}
            {state.indexStatus === 'ready' && !state.chats.length && <div className="agent-pop-hint">No chats in this vault yet.</div>}
            {q && !shown.length && <div className="agent-pop-hint">No chats match.</div>}
            <div className="agent-chats-scroll">
                {grouped.map(group => (
                    <div key={group.label} role="group" aria-label={group.label}>
                        <MenuSection label={group.label} />
                        {group.chats.map(chat => (
                            <div key={chat.id} className="agent-chat-row" onKeyDown={onRowKey}>
                                <MenuRow
                                    title={chat.title}
                                    description={`${AGENT_LABELS[chat.agent]} · ${chat.id === busyChat ? 'replying…' : when(chat.updatedAt, now)}`}
                                    checked={chat.id === activeId}
                                    onSelect={() => open(chat.id)}
                                />
                                <IconButton
                                    size="24"
                                    className="agent-chat-more"
                                    label={`Options for “${chat.title}”`}
                                    tooltip="More"
                                    data-nav-skip=""
                                    onClick={() => setActionsFor(chat.id)}
                                >
                                    <MoreHorizontal />
                                </IconButton>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}

export function ChatList({ state, theme, notify }: { state: ChatStoreState; theme: Theme; notify: Notify }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        if (state.indexStatus === 'error') void chatStore.loadIndex();
        setAnchor(e.currentTarget);
    };

    return (
        <>
            <IconButton
                label="Recent chats"
                tooltip="Chats"
                aria-haspopup="dialog"
                aria-expanded={anchor !== null}
                onClick={toggle}
            >
                <History />
            </IconButton>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Chats" role="dialog" className="agent-chats-popover">
                    <ChatsBody state={state} onClose={() => setAnchor(null)} notify={notify} />
                </Popover>
            )}
        </>
    );
}
