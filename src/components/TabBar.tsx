import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Plus, X } from './icons';
import { TAB_DRAG_TYPE } from '../utils/tabDrag';
import { noteDisplayName } from '../utils/fileTypes';
import { openContextMenu } from '../utils/contextMenu';
import { MAX_PANES } from '../utils/tabPanes';
import type { OpenTab, TabPane } from '../types';

interface TabBarProps {
    /** Every open document, flat — this bar looks documents up by path. */
    tabs: OpenTab[];
    /** The columns, already filtered by EditorPane to those whose activePath
     *  has an open document — index i here IS column i below. */
    panes: TabPane[];
    focusedPaneId: string | null;
    /** The document being dragged right now; owned by EditorPane so its drop
     *  zone agrees with the strip. */
    draggingPath: string | null;
    onSelectTab: (paneId: string, path: string) => void;
    onCloseTab: (path: string) => void;
    /** Move the dragged document into `toPaneId` so it lands at `toIndex`
     *  (an index into that pane's PRE-removal paths). */
    onMoveTab: (path: string, toPaneId: string, toIndex: number) => void;
    onNewTab: (paneId: string) => void;
    onDragStart: (path: string) => void;
    onDragEnd: () => void;
}

/* A tab group's share of the editor, as a `flex-grow` naming its column's
   variable — the SAME variables the columns below read (see EditorPane's
   PANE_WIDTH_STYLE), which is the whole reason a group's right edge lands on
   its divider's rule to the pixel, mid-drag included: the gesture writes those
   variables and both rows move in that one write, with no render at all.

   ONE FROZEN OBJECT PER COLUMN, not one built per render: this component
   re-renders on every keystroke (its dirty dots come from the documents), and
   a fresh style object would make React re-write the property every time. */
const TAB_GROUP_STYLE: React.CSSProperties[] = Array.from(
    { length: MAX_PANES }, (_, i) => ({ flexGrow: `var(--pane-w-${i}, 1)` }));

interface PaneTabsProps {
    pane: TabPane;
    /** This pane's column index — which `--pane-w-<i>` sizes this group. */
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

/**
 * ONE pane's strip: its tabs, then its `+` and `⌄`.
 *
 * A component of its own rather than a loop body, so the insertion caret is
 * LOCAL state: `dragover` fires several times a second, and a caret held by
 * TabBar would re-render every group on every tick instead of the one the
 * pointer is over.
 */
function PaneTabs({ pane, index, byPath, isFocused, draggingPath, onSelectTab, onCloseTab, onMoveTab, onNewTab, onDragStart, onDragEnd }: PaneTabsProps) {
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const activeRef = useRef<HTMLDivElement | null>(null);

    // Keep this pane's showing tab scrolled into view when it changes (e.g.
    // opening a file whose tab is off-screen in a long, horizontally-scrolling
    // strip). Per group: a switch in one column must not scroll another's.
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [pane.activePath]);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, path: string) => {
        onDragStart(path);
        e.dataTransfer.effectAllowed = 'move';
        // Marks this as a tab rather than a tree node, so the file explorer
        // stays inert while it passes over (see utils/tabDrag.ts) — that type is
        // the identity signal, and the only thing readable during dragover.
        e.dataTransfer.setData(TAB_DRAG_TYPE, path);
        // text/plain is what any OTHER drop target gets: a tab dropped into a
        // text field (the search box, an inline rename) pastes this string, and
        // the note's path is the one string that means something there.
        e.dataTransfer.setData('text/plain', path);
    };

    /** Over a tab: the caret goes to whichever half of it the pointer is in. */
    const handleTabDragOver = (e: React.DragEvent<HTMLDivElement>, at: number) => {
        if (draggingPath === null) return;
        e.preventDefault();                          // required or onDrop never fires
        e.stopPropagation();                         // ...and the strip's "append" below must not overwrite this
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setDropIndex(e.clientX < r.left + r.width / 2 ? at : at + 1);
    };

    /** The group's own space, which a tab never covers: the strip's trailing
     *  room, the `+`/`⌄` beside it, and the inset before its first tab. Only
     *  ever reached there, since a tab stops the event above. */
    const handleStripDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (draggingPath === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // The caret is a 2px child of this strip, so a pointer crossing the one
        // already drawn arrives here: leave the index it is showing alone
        // rather than sending it to the end, which made it flicker between two
        // tabs as the pointer passed over its own indicator.
        if ((e.target as HTMLElement).classList.contains('tab-drop-indicator')) return;
        // The strip's left inset sits BEFORE its first tab (18px on the first
        // group, so the active tab's flare is not clipped), and a pointer in it
        // is asking for the front of the strip, not the back of it.
        const first = e.currentTarget.querySelector('.tab');
        setDropIndex(first && e.clientX < first.getBoundingClientRect().left ? 0 : pane.paths.length);
    };

    // On the GROUP, not on each tab: a drop on a tab bubbles here carrying the
    // caret that tab's own dragover computed, so the empty trailing space, the
    // actions beside it and the tabs are one drop with one handler.
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
        // Hung off the button's bottom-left corner rather than the pointer, so
        // it reads as this button's menu however it was pressed — a keyboard
        // Enter carries no useful coordinates at all.
        const r = button.getBoundingClientRect();
        openContextMenu({
            x: Math.round(r.left),
            y: Math.round(r.bottom),
            label: 'Tabs in this pane',
            opener: button,
            entries: pane.paths.map(path => {
                const tab = byPath.get(path);
                return {
                    kind: 'command' as const,
                    id: path,
                    // A file's NAME, stripped like the tab itself — never a
                    // note's text (utils/contextMenu.ts states the rule), and
                    // the full path is still one hover away on the tab.
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
            // On the GROUP, not the strip: `+` and `⌄` stand between the last
            // tab and the group's right edge, which is exactly where a pointer
            // aims when it means "put this at the end of this pane". Handlers
            // on the strip alone left that ~56px refusing the drop outright
            // (no preventDefault, so no drop event and a "no entry" cursor).
            // Dragging out of the group (usually down into the editor, to open
            // a column) must take the insertion caret with it; moving between
            // two tabs also fires dragleave, hence the containment test.
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null); }}
            onDragOver={handleStripDragOver}
            onDrop={handleDrop}
        >
            <div className="tab-group-strip" role="tablist">
                {pane.paths.map((path, i) => {
                    const tab = byPath.get(path);
                    const isActive = path === pane.activePath;
                    // Per TAB now, not OR'd across a group: one tab is one
                    // document again, so the dot and the warning sign say
                    // something about the document whose name they sit beside.
                    const dirty = !!tab?.dirty;
                    const unreadable = !!tab?.readError;
                    // Stripped like the title below, so the × button's accessible
                    // name says what is actually on screen. Falls back to the PATH,
                    // which is left whole.
                    const name = tab ? noteDisplayName(tab.file.name) : path;
                    return (
                        <React.Fragment key={path}>
                            {draggingPath !== null && dropIndex === i && <span className="tab-drop-indicator" />}
                            <div
                                ref={isActive ? activeRef : undefined}
                                className={`tab${isActive ? ' is-active' : ''}${draggingPath === path ? ' is-dragging' : ''}`}
                                role="tab"
                                aria-selected={isActive}
                                title={unreadable
                                    ? `${path}\nCouldn’t be read — press Try again, or click it in the file tree`
                                    : path}
                                draggable
                                onClick={() => onSelectTab(pane.id, path)}
                                onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // no middle-click autoscroll
                                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(path); } }}
                                onDragStart={(e) => handleDragStart(e, path)}
                                onDragOver={(e) => handleTabDragOver(e, i)}
                                onDragEnd={cleanupDrag}
                            >
                                {/* No file-type icon, as Obsidian's tabs have none.
                                    The one icon left is the warning sign of a document
                                    restored without its text (OpenTab.readError):
                                    without it a tab in the background gives no sign
                                    until it is selected. */}
                                {unreadable && (
                                    <span className="tab-icon" aria-hidden="true"><AlertCircle size={13} /></span>
                                )}
                                {/* A note's tab says what the note is CALLED, not what
                                    its file is named — the same convention graph.ts's
                                    baseName has always applied to the graph, backlinks
                                    and [[ autocomplete, so the strip was the odd one
                                    out. Only `.md` goes: a PDF, drawing or notebook tab
                                    keeps its extension, which is how you tell the kinds
                                    apart now that no tab carries a type icon — until the
                                    strip is crowded, where the extension is the first
                                    thing the ellipsis eats and the tooltip is the only
                                    answer (measured at the 80px floor: 4 characters). The full
                                    path stays one hover away, in `title` above. */}
                                <span className="tab-title">{name}</span>
                                <span className="tab-trailing">
                                    {dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
                                    <button
                                        className="tab-close"
                                        aria-label={`Close ${name}`}
                                        draggable={false}
                                        onClick={(e) => { e.stopPropagation(); onCloseTab(path); }}
                                        // Not focused by the press, like a middle-click close:
                                        // a focused × is removed with its tab, dropping the
                                        // keyboard — an Edit-mode caret in the note in front
                                        // lost it to closing a BACKGROUND tab (#35 review).
                                        // So a rename or page field keeps its keyboard (and
                                        // its edit) too, and a press on × never drags the tab.
                                        // Except from ANOTHER × reached by Tab: kept, its
                                        // ring stayed lit while this one was pressed — two
                                        // × looking engaged at once (#35 review 3).
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
                    title="New note in this pane"
                    aria-label="New note in this pane"
                    onClick={() => onNewTab(pane.id)}
                >
                    <Plus size={16} />
                </button>
                <button
                    className="tab-group-btn"
                    title="All tabs in this pane"
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

/**
 * The editor's top row (`.view-header`): ONE tab group per pane, tiling its
 * full width.
 *
 * A group is a column's own strip — its tabs, of which it shows one — and
 * nothing else lives in this row any more, which is what lets the groups tile
 * 100% of it and line each boundary up with the divider below (the document
 * actions are in the pane headers, the save status in the status bar). Click
 * selects, middle-click / the × closes that one document, and native HTML5
 * drag-and-drop either moves a tab within a strip or into another pane's
 * (dropping here) or opens it as a column of its own (dropping on the editor
 * below, see EditorPane).
 */
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
