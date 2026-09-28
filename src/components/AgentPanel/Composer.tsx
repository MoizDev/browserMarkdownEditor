// Where the user writes. Our own design (aicss's input box is a paid Pro
// component), drawn in the free components' language: one 12px card with a
// hairline ring, the thumbnail tray above the text, and a bar below it with
// attach, the model chip and the send/stop button.
//
// Enter sends, Shift+Enter is a newline (and Enter during IME composition is
// the composition's). Images come by paste, by drop anywhere on the panel
// (AgentPanel forwards it here) and by the attach button.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/vaultAgentProtocol';
import { Plus, X } from '../icons';
import { ImagePrepError, looksLikeImage, prepareImage } from './imagePrep';
import type { PreparedImage } from './chatStore';

const MAX_TEXTAREA_PX = 220;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export interface ComposerProps {
    /** Why sending is impossible right now (no agent, history read-only…); null = it is possible. */
    blockedReason: string | null;
    running: boolean;
    stopping: boolean;
    imagesAllowed: boolean;
    /** The model chip. */
    chip: ReactNode;
    onSend: (text: string, images: PreparedImage[]) => void;
    onStop: () => void;
    /** AgentPanel hands dropped files here. */
    registerDrop: (handler: ((files: File[]) => void) | null) => void;
}

export function Composer({ blockedReason, running, stopping, imagesAllowed, chip, onSend, onStop, registerDrop }: ComposerProps) {
    const [text, setText] = useState('');
    const [images, setImages] = useState<PreparedImage[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [preparing, setPreparing] = useState(0);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const imagesRef = useRef(images);
    useEffect(() => { imagesRef.current = images; });

    // Thumbnails still in the tray when the panel unmounts are nobody's.
    useEffect(() => () => { for (const img of imagesRef.current) URL.revokeObjectURL(img.url); }, []);

    useLayoutEffect(() => {
        const el = textarea.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
        el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
    }, [text]);

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

    const removeImage = (id: string) => {
        setImages(prev => {
            const gone = prev.find(i => i.id === id);
            if (gone) URL.revokeObjectURL(gone.url);
            return prev.filter(i => i.id !== id);
        });
    };

    const canSend = !blockedReason && !running && preparing === 0 && (text.trim().length > 0 || images.length > 0);

    const submit = () => {
        if (!canSend) return;
        // The thumbnails' object URLs now belong to the sent message.
        onSend(text.trim(), images);
        setText('');
        setImages([]);
        setError(null);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
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

    return (
        <div className="agent-composer-wrap">
            {error && <div className="agent-composer-error" role="alert">{error}</div>}
            {!imagesAllowed && images.length > 0 && (
                <div className="agent-composer-error">This model can't see images — they won't be sent.</div>
            )}
            <div className={'agent-composer' + (blockedReason ? ' is-blocked' : '')}>
                {(images.length > 0 || preparing > 0) && (
                    <div className="agent-tray">
                        {images.map(img => (
                            <div key={img.id} className="agent-thumb">
                                <img src={img.url} alt={img.name} />
                                <button type="button" className="agent-thumb-remove" aria-label={`Remove ${img.name}`} data-tooltip="Remove" onClick={() => removeImage(img.id)}>
                                    <X size={10} strokeWidth={2.5} />
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
                    placeholder={blockedReason ?? 'Ask about this vault…'}
                    aria-label="Message the agent"
                    disabled={!!blockedReason}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                <div className="agent-composer-bar">
                    <button
                        type="button"
                        className="agent-icon-btn"
                        aria-label="Attach images"
                        data-tooltip="Attach images"
                        data-tooltip-position="top"
                        disabled={!!blockedReason || images.length >= MAX_IMAGES_PER_MESSAGE}
                        onClick={() => fileInput.current?.click()}
                    >
                        <Plus size={16} />
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
                    {chip}
                    <span className="agent-composer-spacer" />
                    {running ? (
                        <button
                            type="button"
                            className="agent-send is-stop"
                            aria-label="Stop"
                            data-tooltip="Stop"
                            data-tooltip-position="top"
                            disabled={stopping}
                            onClick={onStop}
                        >
                            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="agent-send"
                            aria-label="Send"
                            data-tooltip="Send (↵)"
                            data-tooltip-position="top"
                            disabled={!canSend}
                            onClick={submit}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
