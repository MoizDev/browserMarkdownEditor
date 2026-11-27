import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Plus, X } from './icons';
import { TAB_DRAG_TYPE } from '../utils/tabDrag';
import { noteDisplayName } from '../utils/fileTypes';
import { openContextMenu } from '../utils/contextMenu';
import { MAX_PANES } from '../utils/tabPanes';
import type { OpenTab, TabPane } from '../types';

interface TabBarProps {
    tabs: OpenTab[];
    panes: TabPane[];
    focusedPaneId: string | null;
    draggingPath: string | null;
    onSelectTab: (paneId: string, path: string) => void;
    onCloseTab: (path: string) => void;
    onMoveTab: (path: string, toPaneId: string, toIndex: number) => void;
    onNewTab: (paneId: string) => void;
    onDragStart: (path: string) => void;
    onDragEnd: () => void;
}

const TAB_GROUP_STYLE: React.CSSProperties[] = Array.from(
    { length: MAX_PANES }, (_, i) => ({ flexGrow: `var(--pane-w-${i}, 1)` }));

interface PaneTabsProps {
    pane: TabPane;
    index: number;
    byPath: Map<string, OpenTab>;
    isFocused: boolean;
    draggingPath: string | null;
    onSelectTab: (paneId: string, path: string) => void;
    onCloseTab: (path: string) => void;
    onMoveTab: (path: string, toPaneId: string, toIndex: number) => void;
    onNewTab: (paneId: string) => void;
    onDragStart: (path: string) => void;
    onDragEnd: () => void;
}

function PaneTabs({ pane, index, byPath, isFocused, draggingPath, onSelectTab, onCloseTab, onMoveTab, onNewTab, onDragStart, onDragEnd }: PaneTabsProps) {
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const activeRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [pane.activePath]);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, path: string) => {
        onDragStart(path);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DRAG_TYPE, path);
        e.dataTransfer.setData('text/plain', path);
    };

    const handleTabDragOver = (e: React.DragEvent<HTMLDivElement>, at: number) => {
        if (draggingPath === null) return;
        e.preventDefault();                          // required or onDrop never fires
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setDropIndex(e.clientX < r.left + r.width / 2 ? at : at + 1);
    };

    const handleStripDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (draggingPath === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if ((e.target as HTMLElement).classList.contains('tab-drop-indicator')) return;
        const first = e.currentTarget.querySelector('.tab');
        setDropIndex(first && e.clientX < first.getBoundingClientRect().left ? 0 : pane.paths.length);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (draggingPath !== null && dropIndex !== null) onMoveTab(draggingPath, pane.id, dropIndex);
        setDropIndex(null);
        onDragEnd();
    };

    const cleanupDrag = () => { setDropIndex(null); onDragEnd(); };

    const openTabList = (e: React.MouseEvent<HTMLButtonElement>) => {
        const button = e.currentTarget;
        const r = button.getBoundingClientRect();
        openContextMenu({
            x: Math.round(r.left),
            y: Math.round(r.bottom),
            label: 'Tabs in this pane',
            opener: button,
            anchor: button,
            entries: pane.paths.map(path => {
                const tab = byPath.get(path);
                return {
                    kind: 'command' as const,
                    id: path,
                    label: tab ? noteDisplayName(tab.file.name) : path,
                    run: () => onSelectTab(pane.id, path),
                };
            }),
        });
    };

    return (
        <div
            className={`tab-group${isFocused ? ' is-focused' : ''}`}
            style={TAB_GROUP_STYLE[index]}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null); }}
            onDragOver={handleStripDragOver}
            onDrop={handleDrop}
        >
            <div className="tab-group-strip" role="tablist">
                {pane.paths.map((path, i) => {
                    const tab = byPath.get(path);
                    const isActive = path === pane.activePath;
                    const dirty = !!tab?.dirty;
                    const unreadable = !!tab?.readError;
                    const held = tab?.disk;
                    const name = tab ? noteDisplayName(tab.file.name) : path;
                    return (
                        <React.Fragment key={path}>
                            {draggingPath !== null && dropIndex === i && <span className="tab-drop-indicator" />}
                            <div
                                ref={isActive ? activeRef : undefined}
                                className={`tab${isActive ? ' is-active' : ''}${draggingPath === path ? ' is-dragging' : ''}`}
                                role="tab"
                                aria-selected={isActive}
                                data-tooltip={unreadable
                                    ? `${path}\nCouldn’t be read — press Try again, or click it in the file tree`
                                    : held === 'conflict'
                                        ? `${path}\nChanged on disk while you had unsaved edits — not saved until you choose`
                                        : held === 'deleted'
                                            ? `${path}\nDeleted on disk — not saved until you choose`
                                            : path}
                                draggable
                                onClick={() => onSelectTab(pane.id, path)}
                                onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(path); } }}
                                onDragStart={(e) => handleDragStart(e, path)}
                                onDragOver={(e) => handleTabDragOver(e, i)}
                                onDragEnd={cleanupDrag}
                            >
                                {(unreadable || held) && (
                                    <span className="tab-icon" aria-hidden="true"><AlertCircle size={13} /></span>
                                )}
                                <span className="tab-title">{name}</span>
                                <span className="tab-trailing">
                                    {dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
                                    <button
                                        className="tab-close"
                                        aria-label={`Close ${name}`}
                                        draggable={false}
                                        onClick={(e) => { e.stopPropagation(); onCloseTab(path); }}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            e.preventDefault();
                                            const held = document.activeElement;
                                            if (held instanceof HTMLElement && held !== e.currentTarget && held.classList.contains('tab-close')) held.blur();
                                        }}
                                    >
                                        <X size={16} strokeWidth={1.75} />
                                    </button>
                                </span>
                            </div>
                        </React.Fragment>
                    );
                })}
                {draggingPath !== null && dropIndex === pane.paths.length && <span className="tab-drop-indicator" />}
            </div>
            <div className="tab-group-actions">
                <button
                    className="tab-group-btn"
                    data-tooltip="New note in this pane"
                    aria-label="New note in this pane"
                    onClick={() => onNewTab(pane.id)}
                >
                    <Plus size={16} />
                </button>
                <button
                    className="tab-group-btn"
                    data-tooltip="All tabs in this pane"
                    aria-label="All tabs in this pane"
                    aria-haspopup="menu"
                    onClick={openTabList}
                >
                    <ChevronDown size={16} />
                </button>
            </div>
        </div>
    );
}

export default function TabBar({ tabs, panes, focusedPaneId, draggingPath, onSelectTab, onCloseTab, onMoveTab, onNewTab, onDragStart, onDragEnd }: TabBarProps) {
    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);

    return (
        <>
            {panes.map((pane, i) => (
                <PaneTabs
                    key={pane.id}
                    pane={pane}
                    index={i}
                    byPath={byPath}
                    isFocused={pane.id === focusedPaneId}
                    draggingPath={draggingPath}
                    onSelectTab={onSelectTab}
                    onCloseTab={onCloseTab}
                    onMoveTab={onMoveTab}
                    onNewTab={onNewTab}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                />
            ))}
        </>
    );
}
