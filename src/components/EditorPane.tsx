import React, { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from '../editor/cmTheme';
import { createLivePreviewPlugin } from '../editor/livePreview';
import { markdownFormatExtension } from '../editor/formatKeymap';
import { revealHighlightField, setRevealHighlight } from '../editor/revealHighlight';
import { Compartment } from '@codemirror/state';
import { useFileSystem } from '../context/FileSystemContext';
import BacklinksPanel from './BacklinksPanel';
import TabBar from './TabBar';
import { Link, Eye, Edit2 } from './icons';
import { getBacklinkNodes } from '../utils/graph';
import { readJSON, writeJSON } from '../utils/storage';
import { isDrawingFile } from '../utils/fileTypes';
import 'katex/dist/katex.min.css';
import type { ActiveFile, OpenTab, GraphData, GraphNode, Theme, EditorMode, OpenNodeHandler, OpenNoteByNameHandler, EditorRevealRequest } from '../types';

// tldraw is a heavy dependency (canvas engine + its own UI). Loading it lazily
// keeps it out of the initial bundle, so a markdown-only session never pays for
// it — the chunk is fetched the first time a .tldraw file is opened.
const DrawingPane = lazy(() => import('./DrawingPane'));

interface EditorPaneProps {
    activeFile: ActiveFile | null;
    fileContent: string;
    theme: Theme;
    editorMode: EditorMode;
    saveStatus: string;
    tabs: OpenTab[];
    activeTabPath: string | null;
    onSelectTab: (path: string) => void;
    onCloseTab: (path: string) => void;
    onReorderTabs: (path: string, toIndex: number) => void;
    onToggleMode: (path: string) => void;
    onContentChange: (value: string) => void;
    /** Path-explicit (unlike onContentChange, which targets the ACTIVE tab): a
     *  drawing's debounced save can land after a tab switch, and must still be
     *  written to its own file. */
    onDrawingChange: (path: string, content: string) => void;
    onOpenNote: OpenNoteByNameHandler;
    graph: GraphData;
    onOpenNode: OpenNodeHandler;
    /** One-shot select+scroll order from vault search (null = nothing pending). */
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

/** Inline positioning for the linked-mentions popover (fixed top/right). */
interface PopoverPos {
    top: number;
    right: number;
}

/** The theme + syntax-highlight extension pair for the current app theme. */
function themeExtensions(theme: Theme) {
    return theme === 'light'
        ? [obsidianLightTheme, obsidianLightHighlightStyle]
        : [obsidianDarkTheme, obsidianHighlightStyle];
}

export default function EditorPane({ activeFile, fileContent, theme, editorMode, saveStatus, tabs, activeTabPath, onSelectTab, onCloseTab, onReorderTabs, onToggleMode, onContentChange, onDrawingChange, onOpenNote, graph, onOpenNode, revealRequest, onRevealHandled }: EditorPaneProps) {
    const { getAssetUrl, saveAsset } = useFileSystem();

    // A drawing takes over the pane: the tldraw canvas is layered over the
    // (hidden) CodeMirror view rather than replacing it, because the view is
    // created once by a callback ref guarded on `!viewRef.current` — unmounting
    // its container would orphan the view and never re-parent it on the way back.
    const isDrawing = !!activeFile && !activeFile.isHelp && isDrawingFile(activeFile.name);
    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const themeCompartmentRef = useRef<Compartment>(new Compartment());
    const readOnlyCompartmentRef = useRef<Compartment>(new Compartment());
    const livePreviewCompartmentRef = useRef<Compartment>(new Compartment());
    const onContentChangeRef = useRef(onContentChange);
    const activeFileRef = useRef<ActiveFile | null>(activeFile);
    const onOpenNoteRef = useRef(onOpenNote);
    const saveScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const revealClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Per-tab editor state ────────────────────────────────────────────────
    // One CodeMirror EditorView is reused across tabs; each tab's full state
    // (doc + undo history + selection) is cached here and swapped in on switch,
    // so undo can never reach across files and each tab keeps its own history.
    const stateCacheRef = useRef<Map<string, EditorState>>(new Map());
    const prevPathRef = useRef<string | null>(null);
    // True while we programmatically swap the document, so the update listener
    // doesn't mistake a swap for a user edit (which would mark the tab dirty).
    const isSwappingRef = useRef<boolean>(false);

    // ── Linked mentions popover ────────────────────────────────────────────
    const [showBacklinks, setShowBacklinks] = useState(false);
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
    const backlinksBtnRef = useRef<HTMLButtonElement | null>(null);

    const backlinkNodes = useMemo<GraphNode[]>(
        () => getBacklinkNodes(graph, activeFile?.path),
        [graph, activeFile?.path]
    );

    const closeBacklinks = useCallback(() => setShowBacklinks(false), []);

    const toggleBacklinks = useCallback(() => {
        setShowBacklinks(prev => {
            const next = !prev;
            if (next && backlinksBtnRef.current) {
                const r = backlinksBtnRef.current.getBoundingClientRect();
                setPopoverPos({
                    top: Math.round(r.bottom + 6),
                    right: Math.max(8, Math.round(window.innerWidth - r.right)),
                });
            }
            return next;
        });
    }, []);

    // Dismiss the popover on outside-click, Escape, or window resize.
    useEffect(() => {
        if (!showBacklinks) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.backlinks-popover') || target.closest('.backlinks-toggle')) return;
            setShowBacklinks(false);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowBacklinks(false); };
        const onResize = () => setShowBacklinks(false);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', onResize);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);
        };
    }, [showBacklinks]);

    // Debounced scroll persistence
    const handleScroll = (view: EditorView) => {
        if (!activeFileRef.current) return;
        const path = activeFileRef.current.path;
        const scrollTop = view.scrollDOM.scrollTop;

        if (saveScrollTimeoutRef.current) clearTimeout(saveScrollTimeoutRef.current);

        saveScrollTimeoutRef.current = setTimeout(() => {
            const positions = readJSON<Record<string, number>>('fileScrollPositions', {});
            positions[path] = scrollTop;
            writeJSON('fileScrollPositions', positions);
        }, 300);
    };

    // Keep the callback ref up-to-date without re-creating the editor
    useEffect(() => {
        onContentChangeRef.current = onContentChange;
    }, [onContentChange]);

    useEffect(() => {
        activeFileRef.current = activeFile;
    }, [activeFile]);

    useEffect(() => {
        onOpenNoteRef.current = onOpenNote;
    }, [onOpenNote]);

    // Create a bound version of getAssetUrl that includes the active file's parent handle
    const boundGetAssetUrl = useRef<(fileName: string) => Promise<string | null>>((fileName) => getAssetUrl(fileName, null));
    useEffect(() => {
        boundGetAssetUrl.current = (fileName) => getAssetUrl(fileName, activeFile?.parentHandle || null);
    }, [activeFile, getAssetUrl]);

    // Build the full extension list for a document. Shared by the initial view
    // and every fresh per-tab state, so all tabs behave identically. All the
    // dynamic bits (content-change, asset URLs, active file) go through refs.
    const createTabState = (doc: string, mode: EditorMode): EditorState => {
        const updateListener = EditorView.updateListener.of((update) => {
            if (isSwappingRef.current) return;            // ignore programmatic doc swaps
            if (update.docChanged) {
                onContentChangeRef.current(update.state.doc.toString());
            }
        });

        return EditorState.create({
            doc: doc || '',
            extensions: [
                EditorView.lineWrapping,
                // Draw a custom cursor element (.cm-cursor) instead of using the
                // native browser caret, so the caret style/animation settings apply.
                drawSelection(),
                history(),
                closeBrackets(),
                markdown({ base: markdownLanguage, codeLanguages: languages }),
                themeCompartmentRef.current.of(themeExtensions(theme)),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...closeBracketsKeymap,
                    ...searchKeymap,
                ]),
                readOnlyCompartmentRef.current.of(EditorView.editable.of(mode !== 'read')),
                livePreviewCompartmentRef.current.of(createLivePreviewPlugin((fn) => boundGetAssetUrl.current(fn), mode)),
                markdownFormatExtension,
                revealHighlightField,
                updateListener,
                EditorView.domEventHandlers({
                    paste(event, view) {
                        const items = event.clipboardData?.items;
                        if (!items) return false;

                        for (const item of items) {
                            if (item.type.startsWith('image/')) {
                                event.preventDefault();
                                const blob = item.getAsFile();

                                // Generate a filename like Obsidian: Pasted image 20231025143000.png
                                const now = new Date();
                                const timestamp = now.getFullYear().toString() +
                                    (now.getMonth() + 1).toString().padStart(2, '0') +
                                    now.getDate().toString().padStart(2, '0') +
                                    now.getHours().toString().padStart(2, '0') +
                                    now.getMinutes().toString().padStart(2, '0') +
                                    now.getSeconds().toString().padStart(2, '0');

                                // Make sure we carry over the correct extension (e.g. image/png -> .png)
                                const extMatch = item.type.match(/image\/(jpeg|png|gif|webp|svg\+xml)/);
                                let ext = '.png';
                                if (extMatch) {
                                    ext = `.${extMatch[1] === 'svg+xml' ? 'svg' : extMatch[1]}`;
                                }
                                const filename = `Pasted image ${timestamp}${ext}`;

                                // Save the asset to the local .Assets folder (sibling of the active file)
                                const parentHandle = activeFileRef.current?.parentHandle || null;
                                saveAsset(filename, blob!, parentHandle).then(() => {
                                    // Insert the markdown at cursor
                                    const insertText = `![[${filename}]]\n`;
                                    const ranges = view.state.selection.ranges;
                                    if (ranges.length > 0) {
                                        const pos = ranges[0].from;
                                        view.dispatch({
                                            changes: { from: pos, insert: insertText },
                                            selection: { anchor: pos + insertText.length }
                                        });
                                    }
                                }).catch(err => {
                                    console.error('Failed to save pasted image:', err);
                                    alert('Failed to save image to .Assets folder.');
                                });

                                return true; // We handled the paste
                            }
                        }
                        return false;
                    },
                    scroll(event, view) {
                        handleScroll(view);
                    },
                    mousedown(event) {
                        // Navigate when a rendered [[wikilink]] is clicked.
                        const el = (event.target as HTMLElement).closest?.('.cm-wikilink');
                        if (el && onOpenNoteRef.current) {
                            event.preventDefault();
                            onOpenNoteRef.current(el.getAttribute('data-wikilink') as string);
                            return true;
                        }
                        return false;
                    }
                })
            ],
        });
    };

    // Use a callback ref to initialize CodeMirror as soon as the container is
    // mounted. The container is now ALWAYS rendered (even with no file open), so
    // the view is created once and never orphaned by an empty-state unmount.
    const setEditorContainer = (node: HTMLDivElement | null) => {
        editorContainerRef.current = node;
        if (node && !viewRef.current) {
            viewRef.current = new EditorView({
                // A restored .tldraw tab must not seed CodeMirror with its JSON.
                state: createTabState(isDrawing ? '' : fileContent, editorMode),
                parent: node,
            });
            prevPathRef.current = activeFile?.path ?? null;
        }
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (viewRef.current) {
                viewRef.current.destroy();
                viewRef.current = null;
            }
        };
    }, []);

    // Swap the whole editor state when the ACTIVE TAB changes (keyed on path, not
    // content, so typing never triggers a swap). The outgoing tab's state is
    // cached; the incoming tab's cached state is restored (preserving its undo
    // history + selection) or built fresh from its content.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const nextPath = activeFile?.path ?? null;
        if (nextPath === prevPathRef.current) return;

        isSwappingRef.current = true;
        // A drawing tab leaves CodeMirror parked on a blank doc — there's no
        // text state worth caching for it (and caching would key that blank doc
        // under the drawing's path).
        const prevWasDrawing = prevPathRef.current ? isDrawingFile(prevPathRef.current) : false;
        if (prevPathRef.current && !prevWasDrawing) stateCacheRef.current.set(prevPathRef.current, view.state);

        if (isDrawing) {
            // The canvas owns the pane. Park CodeMirror on an empty doc so it
            // never holds — or autosaves — the drawing's JSON.
            view.setState(createTabState('', 'read'));
            isSwappingRef.current = false;
            prevPathRef.current = nextPath;
            return;
        }

        if (nextPath) {
            const cached = stateCacheRef.current.get(nextPath);
            view.setState(cached ?? createTabState(fileContent, editorMode));
            // Cached states may hold a stale theme/mode (or a leftover search
            // reveal flash) → reconfigure/clear for this tab.
            view.dispatch({
                effects: [
                    themeCompartmentRef.current.reconfigure(themeExtensions(theme)),
                    readOnlyCompartmentRef.current.reconfigure(EditorView.editable.of(editorMode !== 'read')),
                    livePreviewCompartmentRef.current.reconfigure(createLivePreviewPlugin((fn) => boundGetAssetUrl.current(fn), editorMode)),
                    setRevealHighlight.of(null),
                ]
            });
        } else {
            // No tab open — show an empty read-only doc behind the overlay.
            view.setState(createTabState('', 'read'));
        }

        isSwappingRef.current = false;
        prevPathRef.current = nextPath;

        // Restore scroll position for the newly-active file.
        if (nextPath) {
            const positions = readJSON<Record<string, number>>('fileScrollPositions', {});
            const savedScrollTop = positions[nextPath];
            requestAnimationFrame(() => {
                if (viewRef.current) {
                    viewRef.current.scrollDOM.scrollTop = savedScrollTop !== undefined ? savedScrollTop : 0;
                }
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFile?.path]);

    // Jump to a search match once its tab is active: select it, scroll it to
    // the vertical center, and flash a highlight decoration (visible even in
    // read mode, where the view may refuse focus so the selection alone could
    // be invisible). Declared AFTER the tab-swap effect so it sees the swapped
    // state, and dispatched inside requestAnimationFrame so it runs after the
    // swap effect's own scroll-position restore (rAFs fire in schedule order).
    useEffect(() => {
        if (!revealRequest || revealRequest.path !== activeFile?.path) return;
        const { from, to } = revealRequest;
        onRevealHandled();

        requestAnimationFrame(() => {
            const view = viewRef.current;
            if (!view) return;
            // The doc may be shorter than the searched text was (e.g. it
            // changed on disk since indexing) — clamp rather than throw.
            const docLen = view.state.doc.length;
            const safeFrom = Math.min(from, docLen);
            const safeTo = Math.min(to, docLen);
            view.dispatch({
                selection: { anchor: safeFrom, head: safeTo },
                effects: [
                    EditorView.scrollIntoView(safeFrom, { y: 'center' }),
                    setRevealHighlight.of({ from: safeFrom, to: safeTo }),
                ],
            });
            view.focus();
        });

        // Let the flash fade after a moment. An earlier reveal's pending
        // fade is cancelled so it can't cut this one short. If the user
        // switched tabs meanwhile, the clear no-ops (that state's field is
        // already empty) and the tab swap clears leftovers on restore.
        if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
        revealClearTimerRef.current = setTimeout(() => {
            viewRef.current?.dispatch({ effects: setRevealHighlight.of(null) });
        }, 1600);
        // No effect cleanup: it would cancel the pending fade when
        // onRevealHandled() nulls the request and re-runs this effect. Both
        // callbacks guard on viewRef; a redundant clear is harmless.
    }, [revealRequest, activeFile?.path, onRevealHandled]);

    // Drop cached editor states for tabs that are no longer open. Keyed on the
    // joined path string so it doesn't run on every keystroke.
    const openTabsKey = tabs.map(t => t.file.path).join('\n');
    useEffect(() => {
        const open = new Set(openTabsKey ? openTabsKey.split('\n') : []);
        for (const key of stateCacheRef.current.keys()) {
            if (!open.has(key)) stateCacheRef.current.delete(key);
        }
    }, [openTabsKey]);

    // Update CodeMirror theme when app theme changes
    useEffect(() => {
        const view = viewRef.current;
        if (view) {
            view.dispatch({
                effects: themeCompartmentRef.current.reconfigure(themeExtensions(theme))
            });
        }
    }, [theme]);

    // Update read-only & live-preview rules when mode or active file changes
    useEffect(() => {
        const view = viewRef.current;
        if (view) {
            view.dispatch({
                effects: [
                    readOnlyCompartmentRef.current.reconfigure(EditorView.editable.of(editorMode !== 'read')),
                    livePreviewCompartmentRef.current.reconfigure(createLivePreviewPlugin((fn) => boundGetAssetUrl.current(fn), editorMode))
                ]
            });
        }
        // Only editorMode: the tab-swap effect already reconfigures these on a
        // path change, so this need not fire again on every switch.
    }, [editorMode]);

    return (
        <div className="editor-pane">
            <div className="view-header">
                <TabBar
                    tabs={tabs}
                    activeTabPath={activeTabPath}
                    onSelectTab={onSelectTab}
                    onCloseTab={onCloseTab}
                    onReorderTabs={onReorderTabs}
                />
                {saveStatus && <span className="save-status">{saveStatus}</span>}
                {/* Read/edit and linked-mentions are markdown concepts — a canvas has neither. */}
                {activeFile && !activeFile.isHelp && !isDrawing && (
                    <>
                        <button
                            className="view-header-action"
                            onClick={() => onToggleMode(activeFile.path)}
                            title={editorMode === 'read' ? 'Reading — switch to edit (⌘E)' : 'Editing — switch to reading (⌘E)'}
                            aria-label="Toggle read/edit mode"
                        >
                            {editorMode === 'read' ? <Eye size={15} /> : <Edit2 size={15} />}
                        </button>
                        <button
                            ref={backlinksBtnRef}
                            className={`view-header-action backlinks-toggle${showBacklinks ? ' active' : ''}`}
                            onClick={toggleBacklinks}
                            title="Linked mentions"
                            aria-label="Linked mentions"
                            aria-expanded={showBacklinks}
                        >
                            <Link size={15} />
                            {backlinkNodes.length > 0 && (
                                <span className="view-header-action-count">{backlinkNodes.length}</span>
                            )}
                        </button>
                    </>
                )}
            </div>
            <div
                className="view-content"
                ref={setEditorContainer}
                style={isDrawing ? { display: 'none' } : undefined}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                    e.preventDefault();
                    if (!activeFile) return;
                    const item = e.dataTransfer.items?.[0];
                    if (!item || item.kind !== 'file') return;
                    const file = item.getAsFile();
                    if (!file || !file.name.endsWith('.md')) return;
                    const text = await file.text();
                    // Overwrite the active document; the update listener marks the
                    // tab dirty and schedules the save.
                    const view = viewRef.current;
                    if (view) {
                        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
                    }
                }}
            />
            {isDrawing && activeFile && (
                <Suspense fallback={<div className="drawing-pane drawing-pane-loading">Loading whiteboard…</div>}>
                    {/* Keyed on path: each drawing gets its own tldraw instance,
                        loaded from its own snapshot. */}
                    <DrawingPane
                        key={activeFile.path}
                        filePath={activeFile.path}
                        content={fileContent}
                        onContentChange={onDrawingChange}
                        theme={theme}
                    />
                </Suspense>
            )}
            {!activeFile && (
                <div className="editor-empty-overlay">
                    <div className="editor-empty-inner">
                        <p className="editor-empty-title">No file open</p>
                        <p className="editor-empty-hint">Select a file from the sidebar to begin editing.</p>
                    </div>
                </div>
            )}
            {showBacklinks && activeFile && !activeFile.isHelp && (
                <BacklinksPanel
                    nodes={backlinkNodes}
                    onOpenNode={onOpenNode}
                    onClose={closeBacklinks}
                    style={popoverPos ? { position: 'fixed', top: popoverPos.top, right: popoverPos.right } : undefined}
                />
            )}
        </div>
    );
}
