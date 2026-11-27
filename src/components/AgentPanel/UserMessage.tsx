import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from './chatStore';
import { CodeBlock } from './aicss/CodeBlock';
import { ChevronLeft, ChevronRight, ChevronRight as Caret, Pencil } from '../icons';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

export interface UserMessageProps {
    item: UserItem;
    version?: { index: number; count: number };
    canEdit?: boolean;
    onEdit?: (text: string) => void;
    onVersion?: (index: number) => void;
}

export function UserMessage({ item, version, canEdit = false, onEdit, onVersion }: UserMessageProps) {
    const [showContext, setShowContext] = useState(false);
    const [draft, setDraft] = useState<string | null>(null);
    const box = useRef<HTMLTextAreaElement>(null);
    const missingThumbs = item.imageCount - item.thumbs.length;
    const editing = draft !== null;

    useEffect(() => {
        const field = box.current;
        if (!editing || !field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
    }, [editing]);

    const commit = () => {
        const text = draft?.trim() ?? '';
        setDraft(null);
        if (text && text !== item.text.trim()) onEdit?.(text);
    };

    if (editing) {
        return (
            <div className="agent-user is-editing">
                <textarea
                    ref={box}
                    className="agent-user-edit"
                    value={draft}
                    rows={1}
                    onChange={(e) => {
                        setDraft(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                    }}
                    aria-label="Edit this message"
                />
                <div className="agent-user-edit-actions">
                    <button type="button" className="agent-link" onClick={() => setDraft(null)}>Cancel</button>
                    <button type="button" className="agent-edit-send" onClick={commit}>Send</button>
                </div>
            </div>
        );
    }

    return (
        <div className="agent-user">
            {item.thumbs.length > 0 && (
                <div className="agent-user-images">
                    {item.thumbs.map((url, i) => <img key={i} src={url} alt={`Attached image ${i + 1}`} />)}
                </div>
            )}
            {missingThumbs > 0 && (
                <div className="agent-user-image-count">{missingThumbs === 1 ? '1 image' : `${missingThumbs} images`} attached</div>
            )}
            {item.text && <div className="agent-user-bubble aic-prose">{item.text}</div>}
            <div className="agent-user-tools">
                {version && version.count > 1 && (
                    <div className="agent-versions" role="group" aria-label="Versions of this message">
                        <button
                            type="button"
                            className="agent-version-step"
                            disabled={version.index === 0}
                            onClick={() => onVersion?.(version.index - 1)}
                            data-tooltip="Previous version"
                            data-tooltip-position="top"
                            aria-label="Previous version of this message"
                        >
                            <ChevronLeft size={12} />
                        </button>
                        <span className="agent-version-count" aria-live="polite">{version.index + 1}/{version.count}</span>
                        <button
                            type="button"
                            className="agent-version-step"
                            disabled={version.index === version.count - 1}
                            onClick={() => onVersion?.(version.index + 1)}
                            data-tooltip="Next version"
                            data-tooltip-position="top"
                            aria-label="Next version of this message"
                        >
                            <ChevronRight size={12} />
                        </button>
                    </div>
                )}
                {onEdit && (
                    <button
                        type="button"
                        className="agent-edit-btn"
                        disabled={!canEdit}
                        onClick={() => setDraft(item.text)}
                        data-tooltip={canEdit ? 'Edit and send again' : 'Wait for the reply to finish'}
                        data-tooltip-position="top"
                        aria-label="Edit this message"
                    >
                        <Pencil size={12} />
                    </button>
                )}
            </div>
            {item.context && (
                <div className="agent-user-context">
                    <button type="button" className="agent-disclosure" aria-expanded={showContext} onClick={() => setShowContext(s => !s)}>
                        <Caret size={11} aria-hidden="true" />
                        Context sent
                    </button>
                    {showContext && <CodeBlock lang="context" code={item.context} maxHeight={260} lineNumbers={false} />}
                </div>
            )}
        </div>
    );
}
