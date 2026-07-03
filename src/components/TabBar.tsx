import React, { useEffect, useRef, useState } from 'react';
import { X } from './icons';
import type { OpenTab } from '../types';

interface TabBarProps {
    tabs: OpenTab[];
    activeTabPath: string | null;
    onSelectTab: (path: string) => void;
    onCloseTab: (path: string) => void;
    /** Move the tab with `path` so it lands at `toIndex` (index in the pre-removal array). */
    onReorderTabs: (path: string, toIndex: number) => void;
}

/**
 * The tab strip shown inside the editor's top-bar (`.view-header`). One `.tab`
 * per open document, keyed by `file.path` so the dragged DOM node survives a
 * reorder. Click selects, middle-click / the × button closes, and native HTML5
 * drag-and-drop reorders with a thin insertion indicator.
 */
export default function TabBar({ tabs, activeTabPath, onSelectTab, onCloseTab, onReorderTabs }: TabBarProps) {
    const [draggingPath, setDraggingPath] = useState<string | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const activeRef = useRef<HTMLDivElement | null>(null);

    // Keep the active tab scrolled into view when it changes (e.g. opening a
    // file whose tab is off-screen in a long, horizontally-scrolling strip).
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeTabPath]);

    const cleanupDrag = () => { setDraggingPath(null); setDropIndex(null); };

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, path: string) => {
        setDraggingPath(path);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', path); // required for Firefox to start a drag
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
        if (draggingPath === null) return;
        e.preventDefault();                          // required or onDrop never fires
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setDropIndex(e.clientX < r.left + r.width / 2 ? index : index + 1);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (draggingPath !== null && dropIndex !== null) onReorderTabs(draggingPath, dropIndex);
        cleanupDrag();
    };

    return (
        <div className="tab-bar" role="tablist">
            {tabs.map((tab, i) => {
                const path = tab.file.path;
                const isActive = path === activeTabPath;
                return (
                    <React.Fragment key={path}>
                        {draggingPath !== null && dropIndex === i && <span className="tab-drop-indicator" />}
                        <div
                            ref={isActive ? activeRef : undefined}
                            className={`tab${isActive ? ' is-active' : ''}${draggingPath === path ? ' is-dragging' : ''}`}
                            role="tab"
                            aria-selected={isActive}
                            title={path}
                            draggable
                            onClick={() => onSelectTab(path)}
                            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // no middle-click autoscroll
                            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(path); } }}
                            onDragStart={(e) => handleDragStart(e, path)}
                            onDragOver={(e) => handleDragOver(e, i)}
                            onDrop={handleDrop}
                            onDragEnd={cleanupDrag}
                        >
                            <span className="tab-title">{tab.file.name}</span>
                            <span className="tab-trailing">
                                {tab.dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
                                <button
                                    className="tab-close"
                                    aria-label={`Close ${tab.file.name}`}
                                    draggable={false}
                                    onClick={(e) => { e.stopPropagation(); onCloseTab(path); }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <X size={12} />
                                </button>
                            </span>
                        </div>
                    </React.Fragment>
                );
            })}
            {draggingPath !== null && dropIndex === tabs.length && <span className="tab-drop-indicator" />}
        </div>
    );
}
