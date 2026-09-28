// The header's chat switcher: this vault's chats (from .VaultAgent/chats.json),
// newest first, a New chat row, and a delete button per chat. Deleting is
// permanent — after the app's own confirm, it also removes the CLI's own
// session (chatStore.deleteChat).

import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { AGENT_LABELS } from '../../../shared/vaultAgentProtocol';
import type { Theme } from '../../types';
import { ChevronDown, Plus, Trash2 } from '../icons';
import { Popover } from './Popover';
import { activeChatOf, chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';

function when(ms: number): string {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d} d ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ChatList({ state, theme }: { state: ChatStoreState; theme: Theme }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const active = activeChatOf(state);
    const title = active?.title ?? 'New chat';
    const busyChat = state.run?.chatId;

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        if (state.indexStatus === 'error') void chatStore.loadIndex();
        setAnchor(e.currentTarget);
    };
    const open = (id: string) => { setAnchor(null); chatStore.openChat(id); };
    const remove = (id: string) => { setAnchor(null); void chatStore.deleteChat(id); };
    const onRowKey = (e: KeyboardEvent, id: string) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(id); }
    };

    return (
        <>
            <button
                type="button"
                className="agent-chat-switch"
                aria-haspopup="menu"
                aria-expanded={anchor !== null}
                onClick={toggle}
                data-tooltip="Chats in this vault"
            >
                <span className="agent-chat-switch-title">{title}</span>
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Chats" className="agent-chats-popover">
                    <button
                        type="button"
                        role="menuitem"
                        className="agent-popover-row"
                        onClick={() => { setAnchor(null); chatStore.newChat(); }}
                    >
                        <Plus size={14} aria-hidden="true" />
                        <span className="agent-popover-row-title">New chat</span>
                    </button>
                    <div className="agent-popover-sep" role="separator" />
                    {state.indexStatus === 'loading' && !state.chats.length && <div className="agent-popover-note">Loading…</div>}
                    {state.indexStatus === 'error' && <div className="agent-popover-note">Couldn't read this vault's chats. {state.indexError}</div>}
                    {state.indexStatus === 'ready' && !state.chats.length && <div className="agent-popover-note">No chats in this vault yet.</div>}
                    <div className="agent-chats-scroll">
                        {state.chats.map(chat => (
                            <div key={chat.id} className="agent-chat-row" role="none">
                                <button
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={chat.id === active?.id}
                                    className="agent-popover-row"
                                    onClick={() => open(chat.id)}
                                    onKeyDown={e => onRowKey(e, chat.id)}
                                >
                                    <span className="agent-popover-row-main">
                                        <span className="agent-popover-row-title">{chat.title}</span>
                                        <span className="agent-popover-row-meta">
                                            {AGENT_LABELS[chat.agent]} · {chat.id === busyChat ? 'replying…' : when(chat.updatedAt)}
                                        </span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className="agent-icon-btn agent-chat-delete"
                                    tabIndex={-1}
                                    aria-label={`Delete “${chat.title}”`}
                                    data-tooltip="Delete chat"
                                    onClick={() => remove(chat.id)}
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))}
                    </div>
                </Popover>
            )}
        </>
    );
}
