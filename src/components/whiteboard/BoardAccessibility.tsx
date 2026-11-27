import { useEffect, useId, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import './boardAccessibility.css';

export interface BoardAccessibilityItem {
    id: string;
    label: string;
    selected: boolean;
}
export interface BoardAccessibilitySnapshot {
    sheetName: string;
    total: number;
    items: readonly BoardAccessibilityItem[];
    selectedCount: number;
    focusedId: string | null;
}
export interface BoardAccessibilitySource {
    getSnapshot(): BoardAccessibilitySnapshot;
    subscribe(listener: () => void): () => void;
}
interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role'> {
    name: string;
    source: BoardAccessibilitySource;
    isVisible: boolean;
    readOnly: boolean;
    mirrorEnabled?: boolean;
    interactionRef?: Ref<HTMLDivElement>;
    children: ReactNode;
}

export default function BoardAccessibility({ name, source, isVisible, readOnly, mirrorEnabled = true, interactionRef, children, ...events }: Props) {
    const prefix = useId();
    const [snapshot, setSnapshot] = useState<BoardAccessibilitySnapshot | null>(null);
    useEffect(() => {
        if (!isVisible || !mirrorEnabled) { setSnapshot(null); return; }
        let frame = 0;
        let alive = true;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (alive) setSnapshot(source.getSnapshot());
            });
        };
        const unsubscribe = source.subscribe(schedule);
        schedule();
        return () => { alive = false; unsubscribe(); if (frame) cancelAnimationFrame(frame); };
    }, [source, isVisible, mirrorEnabled]);

    const current = isVisible ? snapshot : null;
    const items = current?.items ?? [];
    const optionId = (id: string) => `${prefix}-node-${Array.from(id, c => c.codePointAt(0)!.toString(16)).join('-')}`;
    const focusId = current?.focusedId && items.some(item => item.id === current.focusedId) ? optionId(current.focusedId) : undefined;
    const selectedListed = items.reduce((count, item) => count + Number(item.selected), 0);
    const moreSelected = Math.max(0, (current?.selectedCount ?? 0) - selectedListed);
    const summary = !current?.selectedCount ? 'Nothing selected' : `${current.selectedCount - moreSelected} selected${moreSelected ? ` and ${moreSelected} more selected` : ''}`;
    const description = `${prefix}-description`;

    if (!mirrorEnabled) return <div className="board-a11y-group" role="group" aria-roledescription="board" aria-label={name} aria-readonly={readOnly}>
        <div {...events} ref={interactionRef} className={`board-interaction-root${events.className ? ` ${events.className}` : ''}`}
            role="group" tabIndex={0} aria-label="Board interaction">{children}</div>
    </div>;

    return <div className="board-a11y-group" role="group" aria-roledescription="board" aria-label={`${name}: ${current?.sheetName ?? ''}`} aria-readonly={readOnly}>
        <div {...events} ref={interactionRef} className={`board-interaction-root${events.className ? ` ${events.className}` : ''}`}
            role="listbox" tabIndex={0} aria-label="Board content" aria-multiselectable="true"
            aria-describedby={description} aria-activedescendant={focusId}>
            {children}
            <div className="board-a11y-hidden">
                {items.map(item => <div role="option" key={item.id} id={optionId(item.id)} aria-selected={item.selected}>{Array.from(item.label).slice(0, 200).join('')}</div>)}
            </div>
        </div>
        <div className="board-a11y-hidden"><span id={description}>{current?.total ?? 0} nodes; those near the view are listed</span><span>{summary}</span></div>
    </div>;
}
