import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Columns, FileText, PenTool, X } from './icons';
import { isDrawingFile } from '../utils/fileTypes';
import { TAB_DRAG_TYPE } from '../utils/tabDrag';
import type { OpenTab, TabGroup } from '../types';

interface TabBarProps {
    /** Every open document, flat — this bar looks documents up by path. */
    tabs: OpenTab[];
    /** One entry per tab: the documents it shows, in pane order. */
    groups: TabGroup[];
    activeGroupId: string | null;
    /** The tab being dragged right now, so the editor's drop zone and this bar
     *  agree about what is in flight. Owned by EditorPane. */
    draggingGroupId: string | null;
    onSelectGroup: (id: string) => void;
    onCloseGroup: (id: string) => void;
    /** Move the dragged tab so it lands at `toIndex` (index in the pre-removal array). */
    onReorderGroups: (id: string, toIndex: number) => void;
    onDragStart: (id: string) => void;
    onDragEnd: () => void;
}

/** The same file-type icons the explorer uses, so a tab and its tree row read
 *  as the same thing. */
function tabIcon(tab: OpenTab | undefined) {
    if (tab && !tab.file.isHelp && isDrawingFile(tab.file.name)) return <PenTool size={13} />;
    return <FileText size={13} />;
}

/**
 * The tab strip shown inside the editor's top-bar (`.view-header`). One `.tab`
 * per GROUP — usually a single document, and up to five once tabs have been
 * merged into a split view — keyed by group id so the dragged DOM node survives
 * a reorder. Click selects, middle-click / the × button closes the whole tab,
 * and native HTML5 drag-and-drop either reorders the strip (dropping here) or
 * merges the tab into the split view (dropping on the editor below, see
 * EditorPane).
 */
export default function TabBar({ tabs, groups, activeGroupId, draggingGroupId, onSelectGroup, onCloseGroup, onReorderGroups, onDragStart, onDragEnd }: TabBarProps) {
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const activeRef = useRef<HTMLDivElement | null>(null);

    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);

    // Keep the active tab scrolled into view when it changes (e.g. opening a
    // file whose tab is off-screen in a long, horizontally-scrolling strip).
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeGroupId]);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, id: string, path: string) => {
        onDragStart(id);
        e.dataTransfer.effectAllowed = 'move';
        // Marks this as a tab rather than a tree node, so the file explorer
        // stays inert while it passes over (see utils/tabDrag.ts) — that type is
        // the identity signal, and the only thing readable during dragover.
        e.dataTransfer.setData(TAB_DRAG_TYPE, id);
        // text/plain is what any OTHER drop target gets. It carries the note's
        // path rather than the group id, because a tab dropped into a text field
        // (the search box, an inline rename) pastes this string, and "tg3" means
        // nothing to anyone.
        e.dataTransfer.setData('text/plain', path);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
        if (draggingGroupId === null) return;
        e.preventDefault();                          // required or onDrop never fires
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setDropIndex(e.clientX < r.left + r.width / 2 ? index : index + 1);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (draggingGroupId !== null && dropIndex !== null) onReorderGroups(draggingGroupId, dropIndex);
        setDropIndex(null);
        onDragEnd();
    };

    const cleanupDrag = () => { setDropIndex(null); onDragEnd(); };

    return (
        <div
            className="tab-bar"
            role="tablist"
            // Dragging out of the strip (usually down into the editor, to merge)
            // must take the insertion caret with it. Moving between two tabs
            // also fires this, hence the containment test.
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null); }}
        >
            {groups.map((group, i) => {
                const tab = byPath.get(group.activePath);
                const panes = group.paths.length;
                const isActive = group.id === activeGroupId;
                // A merged tab is dirty when ANY of its documents is: the dot
                // means "this tab has unsaved work", and which pane it is in is
                // the pane headers' business.
                const dirty = group.paths.some(p => byPath.get(p)?.dirty);
                const names = group.paths.map(p => byPath.get(p)?.file.name ?? p);
                return (
                    <React.Fragment key={group.id}>
                        {draggingGroupId !== null && dropIndex === i && <span className="tab-drop-indicator" />}
                        <div
                            ref={isActive ? activeRef : undefined}
                            className={`tab${isActive ? ' is-active' : ''}${draggingGroupId === group.id ? ' is-dragging' : ''}`}
                            role="tab"
                            aria-selected={isActive}
                            title={panes > 1 ? `${panes} panes:\n${names.join('\n')}` : group.activePath}
                            draggable
                            onClick={() => onSelectGroup(group.id)}
                            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // no middle-click autoscroll
                            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseGroup(group.id); } }}
                            onDragStart={(e) => handleDragStart(e, group.id, group.activePath)}
                            onDragOver={(e) => handleDragOver(e, i)}
                            onDrop={handleDrop}
                            onDragEnd={cleanupDrag}
                        >
                            {/* The grab handle the drag is described by — the
                                whole tab is draggable, but the icon is the part
                                that looks like it. */}
                            <span className="tab-icon" aria-hidden="true">{tabIcon(tab)}</span>
                            <span className="tab-title">{tab?.file.name ?? group.activePath}</span>
                            {panes > 1 && (
                                <span className="tab-split-badge" aria-label={`${panes} panes`}>
                                    <Columns size={10} aria-hidden="true" />
                                    {panes}
                                </span>
                            )}
                            <span className="tab-trailing">
                                {dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
                                <button
                                    className="tab-close"
                                    aria-label={panes > 1 ? `Close ${panes} panes` : `Close ${names[0]}`}
                                    draggable={false}
                                    onClick={(e) => { e.stopPropagation(); onCloseGroup(group.id); }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <X size={12} />
                                </button>
                            </span>
                        </div>
                    </React.Fragment>
                );
            })}
            {draggingGroupId !== null && dropIndex === groups.length && <span className="tab-drop-indicator" />}
        </div>
    );
}
