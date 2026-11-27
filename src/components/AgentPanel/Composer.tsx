import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/vaultAgentProtocol';
import { Plus, X } from '../icons';
import { ImagePrepError, looksLikeImage, prepareImage } from './imagePrep';
import type { PreparedImage } from './chatStore';
import { writeJSON } from '../../utils/storage';

const MAX_TEXTAREA_PX = 220;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export interface ComposerProps {
    blockedReason: string | null;
    running: boolean;
    stopping: boolean;
    imagesAllowed: boolean;
    chip: ReactNode;
    onSend: (text: string, images: PreparedImage[]) => void;
    onStop: () => void;
    registerDrop: (handler: ((files: File[]) => void) | null) => void;
    draftKey: string | null;
}

export function Composer({ blockedReason, running, stopping, imagesAllowed, chip, onSend, onStop, registerDrop, draftKey }: ComposerProps) {
    const [text, setText] = useState(() => readDraft(draftKey));
    const [images, setImages] = useState<PreparedImage[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [preparing, setPreparing] = useState(0);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const imagesRef = useRef(images);
    useEffect(() => { imagesRef.current = images; });

    const lastDraftKey = useRef(draftKey);
    useEffect(() => {
        if (lastDraftKey.current === draftKey) return;
        lastDraftKey.current = draftKey;
        setText(readDraft(draftKey));
    }, [draftKey]);

    useEffect(() => { writeDraft(draftKey, text); }, [draftKey, text]);

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

const DRAFTS_KEY = 'vaultAgentDrafts';

function readDrafts(): Record<string, string> {
    try {
        const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? 'null') as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === 'string' && value) out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

function readDraft(key: string | null): string {
    if (!key) return '';
    return readDrafts()[key] ?? '';
}

const MAX_DRAFTS = 30;

function writeDraft(key: string | null, text: string): void {
    if (!key) return;
    try {
        const drafts = readDrafts();
        if (!text.trim()) {
            if (!(key in drafts)) return;
            delete drafts[key];
        } else {
            if (drafts[key] === text) return;
            delete drafts[key];
            drafts[key] = text;
        }
        const keys = Object.keys(drafts);
        const kept = keys.length <= MAX_DRAFTS ? drafts : Object.fromEntries(
            keys.slice(keys.length - MAX_DRAFTS).map(k => [k, drafts[k]]));
        writeJSON(DRAFTS_KEY, kept);
    } catch {
        // Full or blocked: the draft lives as long as the page does, as before.
    }
}
