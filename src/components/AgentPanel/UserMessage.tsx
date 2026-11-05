// What the user sent: their words (plain text — never markdown-rendered, it is
// what they typed) in a bubble, and the pictures they attached above
// it.
//
// It is also where a conversation FORKS. Under the bubble, on hover (or focus),
// a row: Edit and Copy, and `‹ 2 / 3 ›` when the message has versions — that
// row then stays visible, the arrows being the only sign the other branch
// exists. Editing and sending makes another version of the message, leaving
// the thread under the old one where it was (utils/chatTree.ts).
//
// "Context sent" — the block the editor put in front of the message — is a
// DEVELOPMENT diagnostic: `item.context` is null in a production build, so its
// toggle never appears there (chatStore.ts says why). It sits at the row's far
// left, so it can never push the other buttons along.

import { memo, useEffect, useRef, useState } from 'react';
import type { ChatItem } from './chatStore';
import { chatStore } from './chatStore';
import { copyText } from '../../utils/clipboard';
import { IconButton } from './ui/IconButton';
import { Check, ChevronLeft, ChevronRight, Copy, Pencil } from './ui/icons';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

export interface UserMessageProps {
    item: UserItem;
    /** Which version of this message is shown (0-based), and how many there
     *  are — two numbers, not an object, so the memo below can hold. */
    versionIndex?: number;
    versionCount?: number;
    /** False while a reply is running: editing then would start a second run,
     *  and switching versions would pull the branch out from under it. */
    canEdit?: boolean;
    /** Module-level (stable) callbacks, addressed by the message's id. */
    onEdit?: (id: string, text: string) => void;
    /** Show the version `index` of this message instead. */
    onVersion?: (id: string, index: number) => void;
    /** Bumped to open this message for editing (↑ in an empty composer). */
    editNonce?: number;
}

/** Why the arrows and the pencil wait. */
const WAIT = 'Wait for the reply to finish';

function grow(field: HTMLTextAreaElement) {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
}

function UserMessageImpl({ item, versionIndex = 0, versionCount = 1, canEdit = false, onEdit, onVersion, editNonce = 0 }: UserMessageProps) {
    const [showContext, setShowContext] = useState(false);
    const [draft, setDraft] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    const pencil = useRef<HTMLButtonElement>(null);
    /** Where the edit was opened from — the pencil, or ↑ in the composer —
     *  and so where Escape / Cancel hand the keyboard back (it fell to
     *  <body>, where Esc and typing do nothing). */
    const [openedFrom, setOpenedFrom] = useState<'pencil' | 'composer'>('pencil');
    const refocus = useRef<'pencil' | HTMLElement | null>(null);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const missingThumbs = item.imageCount - item.thumbs.length;
    const editing = draft !== null;
    const versioned = versionCount > 1;

    // "Edit my last message" arrives as a new nonce; adopting it during render
    // (not in an effect) opens the field in the same commit.
    const [seenNonce, setSeenNonce] = useState(editNonce);
    if (editNonce !== seenNonce) {
        setSeenNonce(editNonce);
        if (canEdit && onEdit) { setOpenedFrom('composer'); setDraft(item.text); }
    }

    // Opening puts the caret at the end (the common edit is a correction to
    // the end of what was said); closing hands the keyboard back.
    useEffect(() => {
        const back = refocus.current;
        if (!editing && back) {
            refocus.current = null;
            (back === 'pencil' ? pencil.current : back)?.focus({ preventScroll: true });
        }
        const field = box.current;
        if (!editing || !field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
        grow(field);
        // The whole editor, Send included — not just the field.
        (field.closest('.va-u') ?? field).scrollIntoView({ block: 'nearest' });
    }, [editing]);

    // While a reply runs the edit stays open with its draft, Send disabled
    // and saying why: the store refuses an edit mid-run, and closing the
    // field first threw the typed text away.
    const composer = () => box.current?.closest('.agent-panel')
        ?.querySelector<HTMLTextAreaElement>('.agent-textarea:not(:disabled)') ?? null;
    const close = () => {
        refocus.current = openedFrom === 'pencil' ? 'pencil' : composer();
        setDraft(null);
    };
    const commit = () => {
        if (!canEdit) return;
        const text = draft?.trim() ?? '';
        if (!text || text === item.text.trim()) { close(); return; }
        const field = composer();
        setDraft(null);
        onEdit?.(item.id, text);
        // The edit is a new version, so this row goes; the keyboard goes
        // where a sent message leaves it — the composer.
        requestAnimationFrame(() => {
            if (document.activeElement === document.body || !document.activeElement) field?.focus({ preventScroll: true });
        });
    };

    const copy = async () => {
        if (!(await copyText(item.text))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };

    if (editing) {
        // How many of the message's pictures the edit can no longer send
        // (chatStore keeps them in memory only, for recent messages).
        const images = item.imageCount > 0 ? chatStore.resendableImages(item.id) : null;
        const lost = images ? images.count - images.available : 0;
        return (
            <div className="va-u is-editing">
                <textarea
                    ref={box}
                    className="va-uedit-field"
                    value={draft}
                    rows={1}
                    onChange={(e) => { setDraft(e.target.value); grow(e.target); }}
                    onKeyDown={(e) => {
                        // Enter sends, as it does in the composer; Shift+Enter is
                        // a new line. Escape abandons the edit — and only that:
                        // prevented and stopped, so the panel's own Escape (stop
                        // a run, close the panel) does not also fire.
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
                    }}
                    aria-label="Edit this message"
                    aria-describedby={lost > 0 ? `va-uedit-lost-${item.id}` : undefined}
                />
                {lost > 0 && (
                    <div className="va-uedit-note" id={`va-uedit-lost-${item.id}`}>
                        {lost === 1 ? "1 image can't be re-sent" : `${lost} images can't be re-sent`}
                    </div>
                )}
                <div className="va-uedit-actions">
                    <button type="button" className="va-tbtn" onClick={close}>Cancel</button>
                    <button
                        type="button"
                        className="va-tbtn is-primary"
                        // aria-disabled, not disabled: the tooltip saying why
                        // needs the hover a disabled button never gets.
                        aria-disabled={canEdit ? undefined : true}
                        data-tooltip={canEdit ? undefined : WAIT}
                        data-tooltip-position="top"
                        onClick={commit}
                    >
                        Send
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={'va-u' + (versioned ? ' is-versioned' : '')}>
            {item.thumbs.length > 0 && (
                <div className="va-u-images">
                    {item.thumbs.map((url, i) => <img key={i} src={url} alt={`Attached image ${i + 1}`} />)}
                </div>
            )}
            {missingThumbs > 0 && (
                <div className="va-u-image-count">{missingThumbs === 1 ? '1 image' : `${missingThumbs} images`} attached</div>
            )}
            {item.text && <div className="va-bubble">{item.text}</div>}
            <div className="va-utools">
                {item.context && (
                    <button
                        type="button"
                        className="va-u-context-toggle"
                        aria-expanded={showContext}
                        onClick={() => setShowContext(s => !s)}
                    >
                        <ChevronRight aria-hidden="true" />
                        Context sent
                    </button>
                )}
                {versioned && (
                    <div className="va-versions" role="group" aria-label="Versions of this message">
                        <IconButton
                            size="24"
                            label="Previous version of this message"
                            tooltip={canEdit ? 'Previous version' : WAIT}
                            tooltipPosition="top"
                            disabled={versionIndex === 0}
                            aria-disabled={!canEdit || undefined}
                            className={canEdit ? undefined : 'is-inert'}
                            onClick={() => { if (canEdit) onVersion?.(item.id, versionIndex - 1); }}
                        >
                            <ChevronLeft />
                        </IconButton>
                        <span className="va-version-count" aria-live="polite">{versionIndex + 1} / {versionCount}</span>
                        <IconButton
                            size="24"
                            label="Next version of this message"
                            tooltip={canEdit ? 'Next version' : WAIT}
                            tooltipPosition="top"
                            disabled={versionIndex === versionCount - 1}
                            aria-disabled={!canEdit || undefined}
                            className={canEdit ? undefined : 'is-inert'}
                            onClick={() => { if (canEdit) onVersion?.(item.id, versionIndex + 1); }}
                        >
                            <ChevronRight />
                        </IconButton>
                    </div>
                )}
                {onEdit && (
                    <IconButton
                        ref={pencil}
                        size="24"
                        label="Edit this message"
                        tooltip={canEdit ? 'Edit and send again' : WAIT}
                        tooltipPosition="top"
                        // aria-disabled, not disabled: a disabled button cannot
                        // be hovered for the tooltip that says why.
                        aria-disabled={!canEdit || undefined}
                        className={canEdit ? undefined : 'is-inert'}
                        onClick={() => { if (canEdit) { setOpenedFrom('pencil'); setDraft(item.text); } }}
                    >
                        <Pencil />
                    </IconButton>
                )}
                <IconButton size="24" label={copied ? 'Copied' : 'Copy message'} tooltip={copied ? 'Copied' : 'Copy'} tooltipPosition="top" onClick={() => void copy()}>
                    {copied ? <Check /> : <Copy />}
                </IconButton>
            </div>
            {item.context && showContext && <pre className="va-u-context">{item.context}</pre>}
        </div>
    );
}

export const UserMessage = memo(UserMessageImpl);
