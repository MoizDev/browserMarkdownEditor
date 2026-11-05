// Where the user writes: the composer. One card (the only element in
// the panel with a shadow besides popovers), the image tray above the text, and
// a bar below it — the "+" (attach) and sliders (learning mode, effort) round
// buttons at the left, the model selector and the send/stop square at the right
// — then one caption line under the card.
//
// Enter sends, Shift+Enter is a newline (and Enter during IME composition is
// the composition's). ↑ in an empty box edits the last message (editRequest.ts;
// the conversation does the editing); ⌘↑ / ⌘↓ with the caret at that end of
// the box jump between your messages (turnNav.ts). Esc is the panel's
// (AgentPanel.tsx). Each chat keeps its own draft (drafts.ts).
// Images come by paste, by drop anywhere on the panel (AgentPanel forwards it
// here and says when a drag is over it) and by the "+" menu.
//
// When the agent cannot take a message the card stays, inert: the placeholder
// says why, once, and the caption under it carries the fix (AgentPanel builds
// both). That replaced a red warning card stacked above the composer.

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/vaultAgentProtocol';
import type { Theme } from '../../types';
import { ArrowUp, Camera, ImageIcon, Plus, Square, X } from './ui/icons';
import { MenuRow, MenuSeparator } from './ui/MenuRow';
import { Popover } from './Popover';
import { requestEditLast } from './editRequest';
import { requestTurnJump } from './turnNav';
import { peekDraft, putDraft, subscribeDiscard } from './drafts';
import { ImagePrepError, looksLikeImage, prepareImage } from './imagePrep';
import type { PreparedImage } from './chatStore';
import { getAgentTextSize, subscribeAgentTextSize } from '../../utils/agentTextSize';

/** About ten lines, then it scrolls. */
const MAX_TEXTAREA_PX = 220;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export interface ComposerProps {
    theme: Theme;
    /** The chat the box is writing in (chatStore's key): its draft is parked
     *  when the chat changes, and the next chat's is brought back. */
    draftKey: string;
    /** Why sending is impossible right now — said once, as the placeholder. */
    blockedReason: string | null;
    /** Inert with nothing to say (connecting: the line above says it). */
    inert: boolean;
    placeholder: string;
    /** The line under the card: the fix when blocked, a warning, or the
     *  standing sentence. null = none. */
    caption: ReactNode;
    captionTone: 'std' | 'fix' | 'warn';
    running: boolean;
    stopping: boolean;
    imagesAllowed: boolean;
    /** A drag carrying files is over the panel. */
    dropping: boolean;
    /** There is a message ↑ could edit (and no reply is running). */
    canEditLast: boolean;
    /** The sliders button and the model selector. */
    tools: ReactNode;
    model: ReactNode;
    onSend: (text: string, images: PreparedImage[]) => void;
    onStop: () => void;
    /** AgentPanel hands dropped files here. */
    registerDrop: (handler: ((files: File[]) => void) | null) => void;
    /** Chips on the new-chat screen fill the box through this. */
    registerFill: (fill: ((text: string) => void) | null) => void;
}

export function Composer({
    theme, draftKey, blockedReason, inert, placeholder, caption, captionTone, running, stopping, imagesAllowed, dropping,
    canEditLast, tools, model, onSend, onStop, registerDrop, registerFill,
}: ComposerProps) {
    const [text, setText] = useState(() => peekDraft(draftKey)?.text ?? '');
    const [images, setImages] = useState<PreparedImage[]>(() => peekDraft(draftKey)?.images ?? []);
    const [error, setError] = useState<string | null>(null);
    const [preparing, setPreparing] = useState(0);
    const [attachAnchor, setAttachAnchor] = useState<HTMLElement | null>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const captionId = useId();
    const imagesRef = useRef(images);
    const textRef = useRef(text);
    const keyRef = useRef(draftKey);
    // Layout, so the parking cleanup below reads the last committed values.
    useLayoutEffect(() => { imagesRef.current = images; textRef.current = text; keyRef.current = draftKey; });

    // ── Drafts, one per chat (drafts.ts) ──
    // Another chat: this one's text and thumbnails are parked as the switch
    // commits (the cleanup reads the outgoing chat's values) and the next
    // chat's come back in the same render — adjusting state to a prop the
    // way React documents, so no frame shows the wrong chat's draft. Closing
    // the panel parks too: the thumbnails belong to the draft now, not to
    // this mount.
    const [heldKey, setHeldKey] = useState(draftKey);
    if (heldKey !== draftKey) {
        const next = peekDraft(draftKey);
        setHeldKey(draftKey);
        setText(next?.text ?? '');
        setImages(next?.images ?? []);
    }
    useLayoutEffect(() => () => putDraft(draftKey, textRef.current, imagesRef.current), [draftKey]);
    // New chat drops its draft for good (AgentPanel): if this box holds it, empty it.
    useEffect(() => subscribeDiscard(key => {
        if (key !== keyRef.current) return false;
        for (const img of imagesRef.current) URL.revokeObjectURL(img.url);
        setText('');
        setImages([]);
        return true;
    }), []);

    // Settings → Agent text size changes the line height under a box whose
    // height was pinned at the old one: re-fit on it too, or a larger size
    // clips the first line until the next keystroke.
    const textSize = useSyncExternalStore(subscribeAgentTextSize, getAgentTextSize);
    useLayoutEffect(() => {
        const el = textarea.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
        el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
    }, [text, textSize]);

    useEffect(() => {
        if (!error) return;
        const id = window.setTimeout(() => setError(null), 6000);
        return () => window.clearTimeout(id);
    }, [error]);

    const addFiles = async (files: File[]) => {
        const candidates = files.filter(looksLikeImage);
        if (!candidates.length) {
            if (files.length) setError('Only images can be attached (PNG, JPEG, WebP or GIF).');
            return;
        }
        const room = MAX_IMAGES_PER_MESSAGE - imagesRef.current.length;
        if (room <= 0) { setError(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`); return; }
        const take = candidates.slice(0, room);
        if (candidates.length > room) setError(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message — the rest were left out.`);
        setPreparing(n => n + take.length);
        for (const file of take) {
            try {
                const prepared = await prepareImage(file);
                setImages(prev => {
                    if (prev.length >= MAX_IMAGES_PER_MESSAGE) { URL.revokeObjectURL(prepared.url); return prev; }
                    return [...prev, prepared];
                });
            } catch (e) {
                setError(e instanceof ImagePrepError ? e.message : `Couldn't attach ${file.name || 'the image'}.`);
            } finally {
                setPreparing(n => n - 1);
            }
        }
    };
    const addFilesRef = useRef(addFiles);
    useEffect(() => { addFilesRef.current = addFiles; });

    useEffect(() => {
        registerDrop(files => void addFilesRef.current(files));
        return () => registerDrop(null);
    }, [registerDrop]);

    useEffect(() => {
        registerFill(next => {
            // A box that cannot send keeps its reason in the placeholder;
            // filled text would hide it (the chips are disabled then too).
            const el = textarea.current;
            if (!el || el.disabled) return;
            setText(next);
            el.focus({ preventScroll: true });
            // After React has put the text in, so the caret lands at its end.
            requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
        });
        return () => registerFill(null);
    }, [registerFill]);

    // Removing a thumbnail by keyboard took its × — and the keyboard — with
    // it (measured: <body>). The next thumbnail's × takes it, else the
    // previous one's, else the box.
    const refocusAt = useRef<number | null>(null);
    const removeImage = (id: string, button: HTMLElement) => {
        const at = images.findIndex(i => i.id === id);
        if (document.activeElement === button) refocusAt.current = at;
        setImages(prev => {
            const gone = prev.find(i => i.id === id);
            if (gone) URL.revokeObjectURL(gone.url);
            return prev.filter(i => i.id !== id);
        });
    };
    useLayoutEffect(() => {
        const at = refocusAt.current;
        if (at == null) return;
        refocusAt.current = null;
        const removes = textarea.current?.closest('.agent-composer')?.querySelectorAll<HTMLElement>('.agent-thumb-remove');
        const next = removes?.length ? removes[Math.min(at, removes.length - 1)] : textarea.current;
        next?.focus({ preventScroll: true });
    }, [images]);

    const disabled = !!blockedReason || inert;
    const canSend = !disabled && !running && preparing === 0 && (text.trim().length > 0 || images.length > 0);

    const submit = () => {
        if (!canSend) return;
        // The thumbnails' object URLs now belong to the sent message.
        onSend(text.trim(), images);
        setText('');
        setImages([]);
        setError(null);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        } else if (e.key === 'ArrowUp' && !text && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && canEditLast) {
            // As in a terminal: the last thing you said, back for another go.
            e.preventDefault();
            requestEditLast();
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
            // ⌘↑ / ⌘↓ are the box's own (to its start / end) until the caret
            // is already there; then they are the conversation's, so the
            // jump works from where the keyboard always is.
            const el = e.currentTarget;
            const up = e.key === 'ArrowUp';
            const atEnd = el.selectionStart === el.selectionEnd && el.selectionEnd === (up ? 0 : el.value.length);
            if (!atEnd) return;
            e.preventDefault();
            requestTurnJump(up ? -1 : 1);
        }
    };

    const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData.files).filter(looksLikeImage);
        if (!files.length) return;
        // A screenshot pastes as a picture only; text that comes with a
        // picture (a copied web page) still pastes as text.
        if (!e.clipboardData.getData('text/plain')) e.preventDefault();
        void addFiles(files);
    };

    const full = images.length >= MAX_IMAGES_PER_MESSAGE;

    return (
        <div className={'agent-composer-wrap' + (blockedReason ? ' is-blocked' : '')}>
            {error && <div className="agent-composer-error" role="alert">{error}</div>}
            {!imagesAllowed && images.length > 0 && (
                <div className="agent-composer-error">This model can't see images — they won't be sent.</div>
            )}
            <div className={'agent-composer' + (disabled ? ' is-inert' : '') + (dropping ? ' is-drop' : '')}>
                {(images.length > 0 || preparing > 0) && (
                    <div className="agent-tray">
                        {images.map(img => (
                            <div key={img.id} className="agent-thumb">
                                <img src={img.url} alt={img.name} />
                                <button type="button" className="agent-thumb-remove" aria-label={`Remove ${img.name}`} data-tooltip="Remove" onClick={e => removeImage(img.id, e.currentTarget)}>
                                    <X strokeWidth={2.5} />
                                </button>
                            </div>
                        ))}
                        {Array.from({ length: preparing }, (_, i) => <div key={`p${i}`} className="agent-thumb is-loading" aria-label="Preparing image" />)}
                    </div>
                )}
                <textarea
                    ref={textarea}
                    className="agent-textarea"
                    rows={1}
                    value={text}
                    placeholder={blockedReason ?? placeholder}
                    aria-label="Message VaultAgent"
                    // A disabled field's placeholder is a weak carrier for the
                    // reason; the caption under it carries it as well.
                    aria-describedby={caption ? captionId : undefined}
                    disabled={disabled}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                <div className="agent-composer-bar">
                    <button
                        type="button"
                        className="agent-round-btn"
                        aria-label="Attach"
                        aria-haspopup="menu"
                        aria-expanded={attachAnchor !== null}
                        data-tooltip="Attach"
                        data-tooltip-position="top"
                        disabled={disabled}
                        onClick={e => setAttachAnchor(attachAnchor ? null : e.currentTarget)}
                    >
                        <Plus />
                    </button>
                    <input
                        ref={fileInput}
                        type="file"
                        accept={ACCEPT}
                        multiple
                        hidden
                        onChange={e => {
                            const files = Array.from(e.target.files ?? []);
                            e.target.value = '';
                            void addFiles(files);
                        }}
                    />
                    {tools}
                    <span className="agent-composer-spacer" />
                    {model}
                    {running ? (
                        <button
                            type="button"
                            className="agent-send is-stop"
                            aria-label="Stop"
                            data-tooltip="Stop (Esc)"
                            data-tooltip-position="top"
                            disabled={stopping}
                            onClick={onStop}
                        >
                            <Square />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className={'agent-send' + (canSend ? '' : ' is-idle')}
                            aria-label="Send"
                            data-tooltip="Send (↵)"
                            data-tooltip-position="top"
                            disabled={!canSend}
                            onClick={submit}
                        >
                            <ArrowUp strokeWidth={2.4} />
                        </button>
                    )}
                </div>
            </div>
            {caption && (
                <div id={captionId} className={'agent-caption is-' + captionTone}>
                    {/* The reason, for whoever reads the caption without the
                        placeholder (a screen reader on the disabled box). */}
                    {blockedReason && <span className="agent-sr-only">{blockedReason}. </span>}
                    {caption}
                </div>
            )}
            {attachAnchor && (
                <Popover anchor={attachAnchor} onClose={() => setAttachAnchor(null)} theme={theme} label="Attach" placement="above" className="agent-attach-popover">
                    <MenuRow
                        icon={<ImageIcon />}
                        title="Attach images"
                        description={`PNG, JPEG, WebP or GIF · up to ${MAX_IMAGES_PER_MESSAGE}`}
                        disabled={full}
                        reason={`Up to ${MAX_IMAGES_PER_MESSAGE} images per message`}
                        // Still inside the click's user activation, which the
                        // file picker needs; the menu goes as the picker opens.
                        onSelect={() => { setAttachAnchor(null); fileInput.current?.click(); }}
                    />
                    <MenuRow
                        icon={<Camera />}
                        title="Paste a screenshot"
                        description="⌘V into the message"
                        onSelect={() => { setAttachAnchor(null); textarea.current?.focus(); }}
                    />
                    <MenuSeparator />
                    <div className="agent-pop-hint">You can also drop images anywhere on the panel.</div>
                </Popover>
            )}
        </div>
    );
}
