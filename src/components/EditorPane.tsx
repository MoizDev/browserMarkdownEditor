import { registerReaderHostCommands } from '../utils/documentReading';
import { useSyncExternalStore } from 'react';
import { subscribeDocumentKeyboard } from '../utils/documentKeyboard';
import { getReadingPreferences,subscribeReadingPreferences,setWordEmphasis,updateReadingTypography } from '../utils/readingPreferences';
import { readPdfTextViewState } from '../utils/readerViewState';
import type { PdfReadingBinding } from '../types/reading';
import type { ReaderIntegration } from '../types/reading';
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import BacklinksPanel from './BacklinksPanel';
import DocumentPane from './DocumentPane';
import TabBar from './TabBar';
import { getBacklinkNodes } from '../utils/graph';
import { dismissOnEscape } from '../utils/escapeDismiss';
import { focusWordCounts, subscribeWordCounts, type WordCounts } from '../utils/wordCountStore';
import { isPdfFile, isCanvasFile, isCodeFile, isNotebookFile } from '../utils/fileTypes';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { NativeCanvasHost } from '../types/nativeCanvas';
import { paneSizes, paneById, paneOf, focusedPane, canGoBack, canGoForward, canSplitToPane, MAX_PANES } from '../utils/tabPanes';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import 'katex/dist/katex.min.css';
import type { ActiveFile, ContentChangeOptions, DiskAction, OpenTab, GraphData, GraphNode, TabLayout, Theme, OpenNodeHandler, OpenNoteByNameHandler, EditorRevealRequest } from '../types';

import { getPdfPaneModuleSnapshot, loadPdfPane, subscribePdfPaneModule } from './pdfPaneModule';
import { canvasPaneSlot } from './paneModules';
import { ErrorBoundary, PartFailure, PartFailureBox } from './ErrorBoundary';
import type { PdfPaneComponent } from './pdfPaneModule';
import { useActivated, useFloatingSlot } from './floatingSlot';

const PdfPaneHost = React.memo(function PdfPaneHost({
    reading, tab, emphasisEnabled, typography, onEmphasisChange, onTypographyChange,
    registerKeyboardTarget, ...rest
}: Omit<React.ComponentProps<PdfPaneComponent>, 'reading' | 'documentId'> & {
    reading: ReaderIntegration;
    tab: OpenTab;
    emphasisEnabled: boolean;
    typography: PdfReadingBinding['typography'];
    onEmphasisChange: PdfReadingBinding['onEmphasisChange'];
    onTypographyChange: PdfReadingBinding['onTypographyChange'];
    registerKeyboardTarget: PdfReadingBinding['registerKeyboardTarget'];
}) {
    const activated = useActivated(rest.isVisible);
    const module = useSyncExternalStore(subscribePdfPaneModule, getPdfPaneModuleSnapshot);
    const loadingStyle = useFloatingSlot(rest.isVisible, rest.slotIndex ?? 0, rest.slotLeft ?? 0, rest.slotWidth ?? 100);
    useEffect(() => {
        if (activated && (module.status === 'unloaded' || module.status === 'loading')) void loadPdfPane().catch(() => {});
    }, [activated, module.status]);
    const identity = reading.identityForTab(tab);
    const path = tab.file.path;
    const binding = React.useMemo<PdfReadingBinding>(() => ({
        ...reading,
        identity,
        initialRecord: readPdfTextViewState(identity.vaultId, path),
        emphasisEnabled, typography, onEmphasisChange, onTypographyChange, registerKeyboardTarget,
    }), [reading, identity, path, emphasisEnabled, typography, onEmphasisChange, onTypographyChange, registerKeyboardTarget]);
    if (!activated) return null;
    if (module.status !== 'ready') return (
        <div
            className={`pdf-pane pdf-pane-message${rest.isVisible ? '' : ' pdf-pane-hidden'}${module.status === 'error' ? '' : ' is-waiting'}`}
            style={loadingStyle}
            role={module.status === 'error' ? 'alert' : 'status'}
            onPointerDownCapture={() => { if (rest.isVisible) rest.onFocusPane(rest.file.path); }}
        >
            {module.status === 'error' ? <>
                <PartFailure error={module.error} what={<strong>{tab.file.name}</strong>}
                    retry={() => { void loadPdfPane({ retry: true }).catch(() => {}); }} />
                {module.reloadRequired && <span className="unread-pane-hint">If it keeps failing, reload the app.</span>}
            </> : 'Loading PDF…'}
        </div>
    );
    const LoadedPdfPane = module.Component;
    return <LoadedPdfPane reading={binding} documentId={tab.id} {...rest} />;
});
const CanvasPane = canvasPaneSlot.View;

function floatingFailureStyle(index: number): React.CSSProperties {
    return { left: `calc(var(--pane-x-${index}) * 1%)`, width: `calc(var(--pane-w-${index}) * 1%)`, right: 'auto' };
}

interface EditorPaneProps {
    contentOf(path: string): string | undefined;
    documentBuffers: DocumentBufferStore;
    nativeCanvasHost: NativeCanvasHost;
    markdownSessions: import('../editor/markdownSession.types').MarkdownSessionHost;
    reading: ReaderIntegration;
    tabs: OpenTab[];
    layout: TabLayout;
    theme: Theme;
    tabSize: number;
    rainbowBrackets: boolean;
    saveStatus: string;
    onSelectTab: (paneId: string, path: string) => void;
    onCloseTab: (path: string) => void;
    onReopenClosedTab: () => void | Promise<string | void>;
    onClosePane: (paneId: string) => void;
    onMoveTab: (path: string, toPaneId: string, toIndex: number) => void;
    onSplitTabToPane: (path: string, at: number) => void;
    onResizePanes: (sizes: number[] | null) => void;
    onNewNote: () => void;
    onPaneBack: (paneId: string) => void;
    onPaneForward: (paneId: string) => void;
    onFocusPane: (path: string) => void;
    onToggleMode: (path: string) => void;
    onContentChange: (path: string, content: string, options?: ContentChangeOptions) => void;
    onNativeCanvasReady: import('../types/reading').NativeCanvasReady;
    attachCanvasSession?: import('../utils/canvasSessionBridge').AttachCanvasSession;
    onDiskAction: (path: string, action: DiskAction) => Promise<void>;
    onAnnotationPreflight: NonNullable<React.ComponentProps<PdfPaneComponent>['onAnnotationPreflight']>;
    onPreparePdfPrint: (path: string) => Promise<{ bytes: Uint8Array; valid: () => boolean; validate: () => Promise<boolean> }>;
    onUnsignedPdfCopy: NonNullable<React.ComponentProps<PdfPaneComponent>['onUnsignedPdfCopy']>;
    onRotatePdf: (path: string, delta: number, pageIndex?: number) => void;
    onAdoptSavedPdfInk: (path: string) => Promise<boolean>;
    onRetryRead: (path: string) => Promise<boolean>;
    onOpenNotebookSource: (pdfPath: string, notebookPath: string) => void;
    onExportNotebook: (file: ActiveFile) => void;
    onOpenNote: OpenNoteByNameHandler;
    getWikiLinkTargets: () => WikiLinkTarget[];
    onNotify: (message: string) => void;
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
    graph: GraphData;
    onOpenNode: OpenNodeHandler;
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

interface PopoverPos {
    bottom: number;
    right: number;
}

interface DropTarget {
    index: number;
    pane: number;
    side: 'left' | 'right';
}

const MIN_PANE_PX = 200;

const pct = (n: number) => n.toFixed(4);

const PANE_WIDTH_STYLE: React.CSSProperties[] = Array.from(
    { length: MAX_PANES }, (_, i) => ({ flexGrow: `var(--pane-w-${i}, 1)` }));

/** A kind change releases the old session even though the document id survives. */
const paneKey = (tab: OpenTab) => `${tab.id}|${tab.representation.loadedKind}`;

function paneFloorPct(totalPx: number): number {
    return totalPx > 0 ? (MIN_PANE_PX / totalPx) * 100 : 0;
}

function clampEdge(want: number, pair: number, floor: number): number {
    const lo = Math.min(floor, pair / 2);
    return Math.min(Math.max(want, lo), pair - lo);
}

interface PaneResize {
    handle: HTMLElement;
    pointerId: number;
    edge: number;
    paneIds: string;
    total: number;
    x0: number;
    x: number;
    start: number[];
    live: number[];
    floor: number;
    frame: number | null;
    onKey: (e: KeyboardEvent) => void;
}

export default function EditorPane({ reading, tabs, contentOf, documentBuffers, nativeCanvasHost, markdownSessions, layout, theme, tabSize, rainbowBrackets, saveStatus, onSelectTab, onCloseTab, onReopenClosedTab, onClosePane, onMoveTab, onSplitTabToPane, onResizePanes, onNewNote, onPaneBack, onPaneForward, onFocusPane, onToggleMode, onContentChange, onNativeCanvasReady, attachCanvasSession, onDiskAction, onAnnotationPreflight, onPreparePdfPrint, onUnsignedPdfCopy, onRotatePdf, onAdoptSavedPdfInk, onRetryRead, onOpenNotebookSource, onExportNotebook, onOpenNote, getWikiLinkTargets, onNotify, onConfirm, graph, onOpenNode, revealRequest, onRevealHandled }: EditorPaneProps) {
    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);

    const { panes, paneTabs, widths } = useMemo(() => {
        const kept: typeof layout.panes = [];
        const docs: OpenTab[] = [];
        const share: number[] = [];
        const stored = paneSizes(layout);
        layout.panes.forEach((pane, i) => {
            const tab = byPath.get(pane.activePath);
            if (!tab) return;
            kept.push(pane);
            docs.push(tab);
            share.push(stored[i]);
        });
        const sum = share.reduce((a, b) => a + b, 0);
        return { panes: kept, paneTabs: docs, widths: sum > 0 ? share.map(s => (s * 100) / sum) : [] };
    }, [layout, byPath]);
    const paneCount = panes.length;

    const edges = useMemo(() => {
        const out: number[] = [];
        let x = 0;
        for (const w of widths) { out.push(x); x += w; }
        return out;
    }, [widths]);

    const paneGeom = useMemo(() => {
        const m = new Map<string, { index: number; left: number; width: number }>();
        paneTabs.forEach((t, i) => m.set(t.file.path, { index: i, left: edges[i], width: widths[i] }));
        return m;
    }, [paneTabs, edges, widths]);

    const splitVars = useMemo(() => {
        const vars: Record<string, string> = {};
        widths.forEach((w, i) => {
            vars[`--pane-w-${i}`] = pct(w);
            vars[`--pane-x-${i}`] = pct(edges[i]);
        });
        return vars as React.CSSProperties;
    }, [widths, edges]);

    const readingPreferences = useSyncExternalStore(subscribeReadingPreferences,getReadingPreferences);
    const paneRootRef = useRef<HTMLDivElement | null>(null);
    const splitRef = useRef<HTMLDivElement | null>(null);

    const focusedPath = focusedPane(layout)?.activePath ?? null;
    const focusedTab = focusedPath ? byPath.get(focusedPath) ?? null : null;
    const activeFile: ActiveFile | null = focusedTab?.file ?? null;
    const unreadable = !!focusedTab?.readError;

    const isDrawing = !!activeFile && !activeFile.isHelp && isCanvasFile(activeFile.name);
    const isPdf = !!activeFile && !activeFile.isHelp && isPdfFile(activeFile.name);
    const isCode = !!activeFile && !activeFile.isHelp && isCodeFile(activeFile.name);
    const isCanvas = isDrawing || isPdf || focusedTab?.representation.loadedKind === 'epub';

    const pendingKeyboardPath = useRef<string|null>(null);
    const focusedPathRef = useRef<string | null>(null);
    const [keyboardTargets] = useState(() => new Map<string, () => void>());
    const registerKeyboardTarget = useCallback((path: string, take: () => void) => {
        keyboardTargets.set(path, take);
        if(pendingKeyboardPath.current===path){
            requestAnimationFrame(()=>{const active=document.activeElement;if(keyboardTargets.get(path)===take&&focusedPathRef.current===path&&!(active instanceof HTMLElement&&(active.isContentEditable||active.closest('input,textarea,select,[role=dialog],[role=menu]')))){pendingKeyboardPath.current=null;take()}});
        }
        // Only its OWN entry: a late cleanup (StrictMode's re-run, an unreadable
        // pane remounting readable) must not delete the newer pane's.
        return () => { if (keyboardTargets.get(path) === take) keyboardTargets.delete(path); };
    }, [keyboardTargets]);
    useLayoutEffect(() => { focusedPathRef.current = focusedPath; }, [focusedPath]);

    const handKeyboardToNote = useCallback(() => {
        requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && (active.isContentEditable
                || active.closest('input, textarea, select, .cm-panels, [role="dialog"], [role="menu"], [role="listbox"]'))) return;
            const path = pendingKeyboardPath.current??focusedPathRef.current;
            if (path) {const take=keyboardTargets.get(path);if(take){pendingKeyboardPath.current=null;take()}else pendingKeyboardPath.current=path;}
        });
    }, [keyboardTargets]);
    const selectFromTabBar = useCallback((paneId: string, path: string) => {
        pendingKeyboardPath.current=path;
        void Promise.resolve(onSelectTab(paneId, path)).then(handKeyboardToNote);
    }, [onSelectTab, handKeyboardToNote]);
    const closeFromTabBar = useCallback((path: string) => {
        void Promise.resolve(onCloseTab(path)).then(handKeyboardToNote);
    }, [onCloseTab, handKeyboardToNote]);
    useEffect(() => subscribeDocumentKeyboard(path => { pendingKeyboardPath.current = path; handKeyboardToNote(); }), [handKeyboardToNote]);
    const layoutRef = useRef(layout);
    useEffect(() => { layoutRef.current = layout; }, [layout]);
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey || e.metaKey || e.ctrlKey) return;
            if (e.target instanceof Element && e.target.closest('[data-terminal]')) return;
            const take = () => { e.preventDefault(); e.stopPropagation(); };
            if (e.key === 'Tab') {
                const l = layoutRef.current;
                const paths = l.panes.flatMap(p => p.paths);
                if (paths.length < 2) return;
                take();
                const at = paths.indexOf(focusedPathRef.current ?? '');
                const next = paths[(((at < 0 ? 0 : at + (e.shiftKey ? -1 : 1)) % paths.length) + paths.length) % paths.length];
                const pane = paneOf(l, next);
                if (pane) selectFromTabBar(pane.id, next);
                return;
            }
            if (!e.shiftKey) return;
            if (e.code === 'KeyW') {
                const path = focusedPathRef.current;
                if (!path) return;
                take();
                closeFromTabBar(path);
            } else if (e.code === 'KeyT') {
                take();
                void Promise.resolve(onReopenClosedTab()).then(path=>{if(path)pendingKeyboardPath.current=path;handKeyboardToNote()});
            }
        };
        const unregister=registerReaderHostCommands(command=>{
            const tab=command==='next-document'||command==='previous-document';
            const code=tab?'Tab':command==='close-document'?'KeyW':'KeyT';
            onKeyDown(new KeyboardEvent('keydown',{key:tab?'Tab':code.slice(3).toLowerCase(),code,altKey:true,shiftKey:!tab||command==='previous-document',cancelable:true}));
        });
        window.addEventListener('keydown', onKeyDown, true);
        return () => {unregister();window.removeEventListener('keydown', onKeyDown, true)};
    }, [selectFromTabBar, closeFromTabBar, onReopenClosedTab, handKeyboardToNote]);

    const newTabInPane = useCallback((paneId: string) => {
        const pane = paneById(layout, paneId);
        if (pane) onSelectTab(paneId, pane.activePath);
        onNewNote();
    }, [layout, onSelectTab, onNewNote]);

    const [showBacklinks, setShowBacklinks] = useState(false);
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
    const backlinksBtnRef = useRef<HTMLButtonElement | null>(null);

    const backlinkNodes = useMemo<GraphNode[]>(
        () => getBacklinkNodes(graph, activeFile?.path),
        [graph, activeFile?.path]
    );

    const closeBacklinks = useCallback(() => setShowBacklinks(false), []);

    const backlinksAvailable = !!activeFile && !activeFile.isHelp && !isCanvas && !unreadable && !isCode;
    if (showBacklinks && !backlinksAvailable) setShowBacklinks(false);

    const toggleBacklinks = useCallback(() => {
        setShowBacklinks(prev => {
            const next = !prev;
            if (next && backlinksBtnRef.current) {
                const r = backlinksBtnRef.current.getBoundingClientRect();
                setPopoverPos({
                    bottom: Math.max(8, Math.round(window.innerHeight - r.top + 6)),
                    right: Math.max(8, Math.round(window.innerWidth - r.right)),
                });
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (!showBacklinks) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.backlinks-popover') || target.closest('.backlinks-toggle')) return;
            setShowBacklinks(false);
        };
        const onResize = () => setShowBacklinks(false);
        document.addEventListener('pointerdown', onPointerDown, true);
        const stopEscape = dismissOnEscape(closeBacklinks);
        window.addEventListener('resize', onResize);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            stopEscape();
            window.removeEventListener('resize', onResize);
        };
    }, [showBacklinks, closeBacklinks]);

    const countable = !!activeFile && !isCanvas && !unreadable && !isCode;
    const statusShown = backlinksAvailable || countable || !!saveStatus;
    const cornerTab = paneTabs.length ? paneTabs[paneTabs.length - 1] : null;
    const liftStatus = !!cornerTab && !cornerTab.file.isHelp && !cornerTab.readError
        && (isPdfFile(cornerTab.file.name) || isCanvasFile(cornerTab.file.name));
    const countPath = countable ? activeFile!.path : null;
    const wordCountRef = useRef<HTMLSpanElement>(null);
    const charCountRef = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const write = ({ words, chars }: WordCounts) => {
            if (wordCountRef.current) wordCountRef.current.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
            if (charCountRef.current) charCountRef.current.textContent = `${chars} ${chars === 1 ? 'character' : 'characters'}`;
        };
        focusWordCounts(countPath);
        const unsubscribe = subscribeWordCounts(write);
        const text = countPath ? contentOf(countPath) : undefined;
        if (text === undefined) {
            if (wordCountRef.current) wordCountRef.current.textContent = '—';
            if (charCountRef.current) charCountRef.current.textContent = '—';
        } else {
            const trimmed = text.trim();
            write({ words: trimmed ? trimmed.split(/\s+/).length : 0, chars: text.length });
        }
        return () => { unsubscribe(); focusWordCounts(null); };
    }, [countPath, contentOf]);

    const [draggingPath, setDraggingPath] = useState<string | null>(null);
    const [dropAt, setDropAt] = useState<DropTarget | null>(null);
    const [overZone, setOverZone] = useState(false);

    const endDrag = useCallback(() => {
        setDraggingPath(null);
        setDropAt(null);
        setOverZone(false);
    }, []);

    const splittable = canSplitToPane(layout, draggingPath);
    const dropFull = overZone && !!draggingPath && !splittable;

    const soloPane = useMemo(() => {
        if (!draggingPath) return -1;
        const i = panes.findIndex(p => p.paths.includes(draggingPath));
        return i >= 0 && panes[i].paths.length === 1 ? i : -1;
    }, [draggingPath, panes]);

    const handleDropOver = (e: React.DragEvent<HTMLDivElement>) => {
        setOverZone(true);
        if (!splittable || paneCount === 0) { setDropAt(null); return; }
        if (widths.length !== layout.panes.length) { setDropAt(null); return; }
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        let pane = 0;
        while (pane + 1 < paneCount && x >= edges[pane + 1]) pane++;
        const right = x - edges[pane] > widths[pane] / 2;
        const index = right ? pane + 1 : pane;
        const side = right ? 'right' : 'left';
        if (index === soloPane || index === soloPane + 1) { setDropAt(null); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropAt(prev => (prev && prev.index === index && prev.pane === pane && prev.side === side)
            ? prev
            : { index, pane, side });
    };

    const handleDropLeave = () => { setOverZone(false); setDropAt(null); };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (draggingPath && dropAt && splittable) onSplitTabToPane(draggingPath, dropAt.index);
        endDrag();
    };

    const resizeRef = useRef<PaneResize | null>(null);

    const writePaneVars = useCallback((cols: number[]) => {
        const root = paneRootRef.current;
        if (!root) return;
        let x = 0;
        for (let i = 0; i < cols.length; i++) {
            root.style.setProperty(`--pane-w-${i}`, pct(cols[i]));
            root.style.setProperty(`--pane-x-${i}`, pct(x));
            x += cols[i];
        }
    }, []);

    /**
     * Stable for the app's life, deliberately: the unmount guard below has it as
     * a dependency, so an identity that moved would run that cleanup — and
     * cancel a live drag — on every re-render, and this component re-renders on
     * every keystroke and every save status.
     */
    const endResize = useCallback((commit: boolean, restore = true) => {
        const drag = resizeRef.current;
        if (!drag) return;
        resizeRef.current = null;
        if (drag.frame !== null) {
            cancelAnimationFrame(drag.frame);
            if (commit) {
                const k = drag.edge;
                const pair = drag.start[k] + drag.start[k + 1];
                const left = clampEdge(drag.start[k] + ((drag.x - drag.x0) / drag.total) * 100, pair, drag.floor);
                drag.live = drag.start.slice();
                drag.live[k] = left;
                drag.live[k + 1] = pair - left;
                writePaneVars(drag.live);
            }
        }
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
            drag.handle.releasePointerCapture(drag.pointerId);
        }
        drag.handle.classList.remove('is-resizing');
        window.removeEventListener('keydown', drag.onKey, true);
        document.body.classList.remove('is-resizing-panes');
        if (commit) onResizePanes(drag.live);
        else if (restore) writePaneVars(drag.start);
    }, [onResizePanes, writePaneVars]);

    const endsGesture = (e: React.PointerEvent<HTMLSpanElement>) =>
        e.pointerId === resizeRef.current?.pointerId;

    useEffect(() => () => { if (resizeRef.current) endResize(false); }, [endResize]);

    const paneIdsKey = panes.map(p => p.id).join('\n');

    useEffect(() => {
        const drag = resizeRef.current;
        if (drag && (drag.paneIds !== paneIdsKey || drag.start.length !== paneCount)) {
            endResize(false, false);
        }
    }, [paneIdsKey, paneCount, endResize]);

    const startResize = (e: React.PointerEvent<HTMLSpanElement>, edge: number) => {
        if (e.button !== 0 || !e.isPrimary || resizeRef.current) return;
        if (widths.length !== layout.panes.length) return;
        const total = splitRef.current?.getBoundingClientRect().width ?? 0;
        if (!(total > 0)) return;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        handle.focus({ preventScroll: true });
        handle.classList.add('is-resizing');
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            ev.preventDefault();
            ev.stopPropagation();
            endResize(false);
        };
        window.addEventListener('keydown', onKey, true);
        document.body.classList.add('is-resizing-panes');
        resizeRef.current = {
            handle, pointerId: e.pointerId, edge, paneIds: paneIdsKey, total,
            x0: e.clientX, x: e.clientX,
            start: widths.slice(), live: widths.slice(),
            floor: paneFloorPct(total), frame: null, onKey,
        };
    };

    const moveResize = (e: React.PointerEvent<HTMLSpanElement>) => {
        const drag = resizeRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag.x = e.clientX;
        if (drag.frame !== null) return;
        drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            const k = drag.edge;
            const pair = drag.start[k] + drag.start[k + 1];
            const left = clampEdge(
                drag.start[k] + ((drag.x - drag.x0) / drag.total) * 100, pair, drag.floor);
            if (Math.abs(left - drag.live[k]) < 0.01) return;
            drag.live = drag.start.slice();
            drag.live[k] = left;
            drag.live[k + 1] = pair - left;
            writePaneVars(drag.live);
        });
    };

    const keyResize = (e: React.KeyboardEvent<HTMLSpanElement>, edge: number) => {
        if (widths.length !== layout.panes.length) return;
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (!step && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const total = splitRef.current?.getBoundingClientRect().width ?? 0;
        const pair = widths[edge] + widths[edge + 1];
        const floor = paneFloorPct(total);
        const want = e.key === 'Home' ? 0
            : e.key === 'End' ? pair
            : widths[edge] + step * (e.shiftKey ? 10 : 2);
        const next = widths.slice();
        next[edge] = clampEdge(want, pair, floor);
        next[edge + 1] = pair - next[edge];
        onResizePanes(next);
    };

    return (
        <div className="editor-pane" ref={paneRootRef} style={splitVars}>
            <div className="view-header">
                <TabBar
                    tabs={tabs}
                    panes={panes}
                    focusedPaneId={layout.activeId}
                    draggingPath={draggingPath}
                    onSelectTab={selectFromTabBar}
                    onCloseTab={closeFromTabBar}
                    onMoveTab={onMoveTab}
                    onNewTab={newTabInPane}
                    onDragStart={setDraggingPath}
                    onDragEnd={endDrag}
                />
            </div>

            <div className={`editor-split${paneCount > 1 ? ' is-split' : ''}`} ref={splitRef}>
                {paneTabs.map((tab, i) => (
                    <ErrorBoundary
                        label={`The pane of ${tab.file.path}`}
                        key={`${paneKey(tab)}${tab.readError ? '|unread' : ''}`}
                        fallback={(error, retry) => (
                            <div className="editor-slot" style={PANE_WIDTH_STYLE[i]}>
                                <div className="editor-slot-header">
                                    <div className="editor-slot-nav" />
                                    <span className="editor-slot-title" data-tooltip={tab.file.path}>{tab.file.name}</span>
                                    <div className="editor-slot-actions" />
                                </div>
                                <div className="editor-slot-body">
                                    <PartFailureBox error={error} retry={retry} what={<strong>{tab.file.name}</strong>} />
                                </div>
                            </div>
                        )}
                    >
                    <DocumentPane
                        reading={reading}
                        tab={tab}
                        paneId={panes[i].id}
                        isFocused={tab.file.path === focusedPath}
                        isSplit={paneCount > 1}
                        canBack={canGoBack(panes[i])}
                        canForward={canGoForward(panes[i])}
                        widthStyle={PANE_WIDTH_STYLE[i]}
                        theme={theme}
                        tabSize={tabSize}
                        rainbowBrackets={rainbowBrackets}
                        contentOf={contentOf}
                        documentBuffers={documentBuffers}
                        markdownSessions={markdownSessions}
                        registerKeyboardTarget={registerKeyboardTarget}
                        getWikiLinkTargets={getWikiLinkTargets}
                        onContentChange={onContentChange}
                        onDiskAction={onDiskAction}
                        onRetryRead={onRetryRead}
                        onFocusPane={onFocusPane}
                        onBack={onPaneBack}
                        onForward={onPaneForward}
                        onClosePane={onClosePane}
                        onToggleMode={onToggleMode}
                        onExportNotebook={onExportNotebook}
                        onOpenNote={onOpenNote}
                        onNotify={onNotify}
                        onConfirm={onConfirm}
                        revealRequest={revealRequest}
                        onRevealHandled={onRevealHandled}
                    />
                    </ErrorBoundary>
                ))}
                {paneTabs.slice(1).map((right, i) => (
                    <span
                        key={right.file.path}
                        className="editor-split-divider"
                        style={{ left: `calc(var(--pane-x-${i + 1}) * 1%)` }}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize the ${paneTabs[i].file.name} and ${right.file.name} panes`}
                        aria-valuenow={Math.round(widths[i])}
                        aria-valuemin={0}
                        aria-valuemax={Math.round(widths[i] + widths[i + 1])}
                        aria-valuetext={`${paneTabs[i].file.name} ${Math.round(widths[i])}%, ${right.file.name} ${Math.round(widths[i + 1])}%`}
                        tabIndex={0}
                        data-tooltip="Drag to resize · double-click for equal widths"
                        data-tooltip-position="right"
                        onPointerDown={(e) => startResize(e, i)}
                        onPointerMove={moveResize}
                        onPointerUp={(e) => { if (endsGesture(e)) endResize(true); }}
                        onPointerCancel={(e) => { if (endsGesture(e)) endResize(false); }}
                        onLostPointerCapture={(e) => { if (endsGesture(e)) endResize(false); }}
                        onKeyDown={(e) => keyResize(e, i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onDoubleClick={() => onResizePanes(null)}
                        // Now that this strip takes pointer events it is also a
                        // drop target, and a file dropped from the desktop on an
                        // uncancelled one navigates the whole app away to it.
                        // It used to fall through to .view-content, which
                        // cancels its own.
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    />
                ))}
                {draggingPath && paneCount > 0 && (
                    <div
                        className="editor-split-dropzone"
                        onDragEnter={handleDropOver}
                        onDragOver={handleDropOver}
                        onDragLeave={handleDropLeave}
                        onDrop={handleDrop}
                    >
                        {dropAt && dropAt.pane < paneCount && (
                            <div
                                className="editor-split-drop-target"
                                style={{
                                    left: `${edges[dropAt.pane] + (dropAt.side === 'right' ? widths[dropAt.pane] / 2 : 0)}%`,
                                    width: `${widths[dropAt.pane] / 2}%`,
                                }}
                            />
                        )}
                        {dropFull && (
                            <div className="editor-split-drop-note">
                                The editor holds up to {MAX_PANES} panes side by side
                            </div>
                        )}
                    </div>
                )}
            </div>

            {tabs.filter(t => !t.file.isHelp && !t.readError && t.representation.loadedKind === 'pdf').map(tab => {
                const slot = paneGeom.get(tab.file.path);
                const visible = !!slot;
                return (
                    <ErrorBoundary
                        label={`The PDF pane of ${tab.file.path}`}
                        key={`${paneKey(tab)}|${tab.diskRev ?? 0}`}
                        fallback={(error, retry) => slot && (
                            <div className="canvas-pane" style={floatingFailureStyle(slot.index)}>
                                <PartFailureBox error={error} retry={retry} what={<strong>{tab.file.name}</strong>} />
                            </div>
                        )}
                    >
                        <PdfPaneHost
                            reading={reading}
                            tab={tab}
                            emphasisEnabled={readingPreferences.emphasis.enabled}
                            typography={readingPreferences.typography}
                            onEmphasisChange={setWordEmphasis}
                            onTypographyChange={updateReadingTypography}
                            registerKeyboardTarget={registerKeyboardTarget}
                            file={tab.file}
                            theme={theme}
                            nativeCanvasHost={nativeCanvasHost}
                            onToggleMode={onToggleMode}
                            isVisible={visible}
                            isFocused={tab.file.path === focusedPath}
                            slotIndex={slot?.index ?? 0}
                            slotLeft={slot?.left ?? 0}
                            slotWidth={slot?.width ?? 100}
                            onFocusPane={onFocusPane}
                            mode={tab.mode}
                            onNativeCanvasReady={onNativeCanvasReady}
                            attachCanvasSession={attachCanvasSession}
                            onPreparePrint={onPreparePdfPrint}
                            onUnsignedPdfCopy={onUnsignedPdfCopy}
                            onOpenNotebookSource={onOpenNotebookSource}
                            onRotate={onRotatePdf}
                            onAdoptSavedInk={onAdoptSavedPdfInk}
                            // Unsaved bytes only: tab.dirty also counts native session journalling and
                            // rebind work, which held Original behind "Applying annotations…" forever
                            // after a completed save (t5zy/t606). The header keeps the combined flag.
                            isDirty={documentBuffers.isDirty(tab.id)}
                            disk={tab.disk}
                            diskMineLost={tab.diskMineLost}
                            pdfRebuild={tab.pdfRebuild}
                            pdfRebuildApproval={tab.pdfRebuild?.approved ? tab.pdfRebuild : undefined}
                            onAnnotationPreflight={onAnnotationPreflight}
                            onDiskAction={onDiskAction}
                        />
                    </ErrorBoundary>
                );
            })}

            {tabs.filter(t => !t.file.isHelp && !t.readError
                && (t.representation.loadedKind === 'drawing' || t.representation.loadedKind === 'notebook')).map(tab => {
                const slot = paneGeom.get(tab.file.path);
                const visible = !!slot;
                const fallbackStyle = visible ? floatingFailureStyle(slot!.index) : undefined;
                return (
                    <ErrorBoundary
                        label={`The canvas pane of ${tab.file.path}`}
                        key={`${paneKey(tab)}|${tab.diskRev ?? 0}`}
                        fallback={(error, retry) => visible && (
                            <div className="canvas-pane" style={fallbackStyle}>
                                <PartFailureBox error={error} retry={retry} what={<strong>{tab.file.name}</strong>} />
                            </div>
                        )}
                    >
                    <CanvasPane
                        fallback={visible ? (
                            <div className="canvas-pane" style={fallbackStyle}>
                                <div className="drawing-pane drawing-pane-loading">
                                    {isNotebookFile(tab.file.name) ? 'Loading notebook…' : 'Loading drawing…'}
                                </div>
                            </div>
                        ) : null}
                            file={tab.file}
                            documentId={tab.id}
                            nativeCanvasHost={nativeCanvasHost}
                            representation={tab.representation}
                            isVisible={visible}
                            isFocused={tab.file.path === focusedPath}
                            slotIndex={slot?.index ?? 0}
                            slotLeft={slot?.left ?? 0}
                            slotWidth={slot?.width ?? 100}
                            onFocusPane={onFocusPane}
                            registerKeyboardTarget={registerKeyboardTarget}
                            onNativeCanvasReady={onNativeCanvasReady}
                            attachCanvasSession={attachCanvasSession}
                            theme={theme}
                            disk={tab.disk}
                            isDirty={documentBuffers.isDirty(tab.id)}
                            onDiskAction={onDiskAction}
                        />
                    </ErrorBoundary>
                );
            })}

            {statusShown && (
                <div className={`status-bar${liftStatus ? ' is-lifted' : ''}`}>
                    {backlinksAvailable && (
                        <button
                            ref={backlinksBtnRef}
                            className={`status-bar-item status-bar-btn backlinks-toggle${showBacklinks ? ' active' : ''}`}
                            onClick={toggleBacklinks}
                            data-tooltip="Linked mentions"
                            data-tooltip-position="top"
                            aria-label="Linked mentions"
                            aria-expanded={showBacklinks}
                        >
                            {backlinkNodes.length} {backlinkNodes.length === 1 ? 'backlink' : 'backlinks'}
                        </button>
                    )}
                    {countable && (
                        <>
                            <span className="status-bar-item" ref={wordCountRef} />
                            <span className="status-bar-item" ref={charCountRef} />
                        </>
                    )}
                    <span className="status-bar-item save-status">{saveStatus}</span>
                </div>
            )}

            {!activeFile && (
                <div className="editor-empty-overlay">
                    <div className="editor-empty-inner">
                        <p className="editor-empty-title">No file open</p>
                        <p className="editor-empty-hint">Select a file from the sidebar to begin editing.</p>
                    </div>
                </div>
            )}
            {showBacklinks && backlinksAvailable && (
                <BacklinksPanel
                    nodes={backlinkNodes}
                    onOpenNode={onOpenNode}
                    onClose={closeBacklinks}
                    style={popoverPos ? { position: 'fixed', bottom: popoverPos.bottom, right: popoverPos.right } : undefined}
                />
            )}
        </div>
    );
}
