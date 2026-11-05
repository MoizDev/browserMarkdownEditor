// The header's title: the chat's name in medium weight with a chevron, which
// opens Star / Rename / Delete chat — the title menu. On a new chat it
// is just "New chat", with nothing to open (there is no chat yet to rename).
// While a reply runs in this chat a small accent dot pulses after it.
//
// `ChatActions` is the menu's body, shared with the chats menu's per-row ⋯:
// the same three actions on any chat. Rename happens IN the popover (a field
// with Cancel / Rename), not in a separate dialog; Delete goes through
// chatStore.deleteChat, which asks with the app's own confirm first.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import type { ChatMeta } from '../../types/vaultAgent';
import type { Theme } from '../../types';
import { ChevronDown, Pencil, Star, Trash2 } from './ui/icons';
import { MenuRow, MenuSeparator } from './ui/MenuRow';
import { Popover } from './Popover';
import { chatStore } from './chatStore';

/** chats.json titles are shown in a 300px header and a menu row; nobody needs more. */
const MAX_TITLE = 120;

/** Where a failed rename or star is said: the app's own notice. The store
 *  shows the change at once and rolls it back when the write fails, so
 *  without this the title would quietly snap back. */
export type Notify = (message: string) => void;

function failed(notify: Notify, what: string) {
    return (e: unknown) => notify(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
}

/** Where the keyboard goes once Delete's confirm has closed, either way: the
 *  title button when there still is one, else the message box. The menu had
 *  already closed under the confirm, so its row was gone and the keyboard fell
 *  to <body> (measured, confirmed and cancelled alike). Two frames: the store
 *  re-renders on the next (its rAF batch), and only then is it known whether
 *  the title survived — deleting the open chat turns it into static text. */
function refocusAfterDelete() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const panel = document.querySelector('.agent-panel');
        const to = panel?.querySelector<HTMLElement>('button.agent-title') ?? panel?.querySelector<HTMLElement>('.agent-textarea');
        to?.focus({ preventScroll: true });
    }));
}

function RenameForm({ chat, onDone, notify }: { chat: ChatMeta; onDone: () => void; notify: Notify }) {
    const [value, setValue] = useState(chat.title);
    const input = useRef<HTMLInputElement>(null);
    // A passive effect, so it runs after Popover's own focus-on-open (a layout
    // effect) and wins: the field, not the first row, has the keyboard.
    useEffect(() => {
        input.current?.focus({ preventScroll: true });
        input.current?.select();
    }, []);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const next = value.trim().slice(0, MAX_TITLE);
        onDone();
        if (next && next !== chat.title) chatStore.renameChat(chat.id, next).catch(failed(notify, `rename “${chat.title}”`));
    };
    return (
        <form className="agent-pop-dialog" onSubmit={submit}>
            <p>Rename this chat</p>
            <input
                ref={input}
                className="agent-pop-input"
                value={value}
                maxLength={MAX_TITLE}
                aria-label="Chat name"
                onChange={e => setValue(e.target.value)}
                // Home/End belong to the field, not to the menu's row-to-row keys.
                onKeyDown={e => { if (e.key === 'Home' || e.key === 'End') e.stopPropagation(); }}
            />
            <div className="agent-pop-btns">
                <button type="button" className="agent-text-btn is-plain" onClick={onDone}>Cancel</button>
                <button type="submit" className="agent-fill-btn">Rename</button>
            </div>
        </form>
    );
}

/** Star / Rename / Delete chat for one chat. `onDone` closes the menu. */
export function ChatActions({ chat, onDone, notify, heading }: { chat: ChatMeta; onDone: () => void; notify: Notify; heading?: boolean }) {
    const [renaming, setRenaming] = useState(false);
    const view = useRef<HTMLDivElement>(null);
    // Shown in place of the chats list (`heading`), the ⋯ that opened it is
    // gone and the keyboard with it: hand it to the first action.
    useEffect(() => {
        if (heading) view.current?.querySelector<HTMLElement>('.va-menu-row')?.focus({ preventScroll: true });
    }, [heading]);
    if (renaming) return <RenameForm chat={chat} onDone={onDone} notify={notify} />;
    return (
        <div ref={view} className="agent-pop-view">
            {heading && <div className="agent-pop-head">{chat.title}</div>}
            <MenuRow
                icon={<Star fill={chat.starred ? 'currentColor' : 'none'} />}
                title={chat.starred ? 'Unstar' : 'Star'}
                onSelect={() => {
                    onDone();
                    chatStore.setStarred(chat.id, !chat.starred).catch(failed(notify, `${chat.starred ? 'unstar' : 'star'} “${chat.title}”`));
                }}
            />
            <MenuRow icon={<Pencil />} title="Rename" onSelect={() => setRenaming(true)} />
            <MenuSeparator />
            <MenuRow
                icon={<Trash2 />}
                title="Delete chat"
                danger
                onSelect={() => { onDone(); void chatStore.deleteChat(chat.id).finally(refocusAfterDelete); }}
            />
        </div>
    );
}

export function TitleMenu({ chat, running, theme, notify }: { chat: ChatMeta | null; running: boolean; theme: Theme; notify: Notify }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const dot = running && <span className="agent-title-dot" aria-hidden="true" />;

    if (!chat) {
        return (
            <div className="agent-title is-static">
                <span className="agent-title-text">New chat</span>
                {dot}
            </div>
        );
    }

    const toggle = (e: MouseEvent<HTMLButtonElement>) => setAnchor(anchor ? null : e.currentTarget);
    return (
        <>
            <button
                type="button"
                className="agent-title"
                aria-haspopup="dialog"
                aria-expanded={anchor !== null}
                aria-label={`${chat.title}${running ? ', replying' : ''} — chat options`}
                onClick={toggle}
            >
                <span className="agent-title-text">{chat.title}</span>
                <ChevronDown className="agent-title-chev" aria-hidden="true" />
                {dot}
            </button>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Chat options" role="dialog" className="agent-title-popover">
                    <ChatActions chat={chat} onDone={() => setAnchor(null)} notify={notify} />
                </Popover>
            )}
        </>
    );
}
