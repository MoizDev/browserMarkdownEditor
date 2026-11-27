import { captureReadingSelection, queueTableReadingSelection } from '../editor/tableReadingSelection';
import { readingEmphasis,readingEmphasisCompartment,readingEmphasisOptions,deferReadingConfiguration,cancelReadingConfiguration } from '../editor/readingEmphasis';
import { captureWordReadingAnchor,restoreWordReadingAnchor,cancelWordReadingAnchor } from '../editor/scrollAnchor';
import { getReadingPreferences,subscribeReadingPreferences,setWordEmphasis } from '../utils/readingPreferences';
import { canReadTabText,readingCapabilities,getReadingSurface,subscribeReadingSurface } from '../utils/documentReading';
import type { ReaderIntegration } from '../types/reading';
import EpubReaderHost from './EpubReaderHost';
import WordEmphasisToggle from './WordEmphasisToggle';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import type { ChangeDesc, Extension } from '@codemirror/state';
import { createMarkdownSession } from '../editor/markdownSession';
import type { MarkdownSessionHost, MarkdownSessionUpdate } from '../editor/markdownSession.types';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from '../editor/cmTheme';
import { createLivePreviewPlugin, livePreviewField } from '../editor/livePreview';
import { docAnalysisField } from '../editor/docAnalysis';
import { markEditorModeRender } from '../editor/editorPerf';
import type { ImageEmbedActions } from '../editor/imageWidget';
import { markdownFormatExtension } from '../editor/formatKeymap';
import { indentSettings, listIndentKeymap } from '../editor/lists';
import { wikiLinkAutocomplete } from '../editor/wikiLinkComplete';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import { mathEditingExtensions } from '../editor/latexSource';
import { foldedHeadingKeys, headingFold, headingFoldField, isHeadingKeyList, sameHeadingKeys } from '../editor/headingFold';
import type { HeadingKey } from '../editor/headingFold';
import { revealHighlightField, setRevealHighlight } from '../editor/revealHighlight';
import {
    captureScrollAnchor,
    holdScrollAnchor,
    isHoldingScrollAnchor,
    isScrollAnchor,
    mapScrollAnchor,
    parseForReveal,
    revealMatch,
    revealMatchEffect,
    scrollAnchorTracking,
} from '../editor/scrollAnchor';
import type { ScrollAnchor } from '../editor/scrollAnchor';
import { insertTableAtCursor } from '../editor/tableEdit';
import { canWrite, modeExtensions } from '../editor/readingMode';
import { keyboardAfterSearchClose, noteSearchKeymap, returnKeyboard, runNoteSearchKey } from '../editor/noteSearch';
import { findPanel } from '../editor/findPanel';
import { tabIntoText } from '../editor/tabIntoText';
import { docString } from '../editor/docCache';
import { wordCountField } from '../editor/wordCount';
import { publishWordCounts } from '../utils/wordCountStore';
import { reloadSpec } from '../editor/externalReload';
import { registerView, type LineCol, type MarkdownViewInfo, type TextChange } from '../utils/viewRegistry';
import { onTableInsertRequest, requestTableInsert, TABLE_GRID_COLS, TABLE_GRID_ROWS } from '../utils/tableInsertRequest';
import { useFileSystem } from '../context/FileSystemContext';
import { ASSETS_DIR } from '../utils/assets';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { readRecord, flushRecord, scopedKey, removeStoredValue } from '../utils/storage';
import { subscribeDocumentViewRetarget } from '../utils/documentViewRetarget';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
import { copyText, readClipboardText, CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import TexView from './TexView';
import { useDocumentRevision } from '../utils/useDocumentRevision';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import { bracketColourCompartment, codeExtensions, codeLanguageFor, loadCodeLanguage, type CodeLanguage } from '../editor/codeEditor';
import { rainbowBrackets as rainbowBracketsExtension } from '../editor/rainbowBrackets';
import { codeDarkTheme, codeLightTheme } from '../editor/codeHighlight';
import { isCodeFile, isNotebookFile, isTexFile, noteDisplayName } from '../utils/fileTypes';
import { ArrowLeft, ArrowRight, Edit2, Eye, MoreHorizontal, PenTool } from './icons';
import DiskBar from './DiskBar';
import { warmMath } from '../editor/mathWidget';
import type { ActiveFile, ContentChangeOptions, DiskAction, EditorMode, EditorRevealRequest, OpenNoteByNameHandler, OpenTab, Theme } from '../types';

const SCROLL_ANCHORS_KEY = 'fileScrollAnchors';
const LEGACY_SCROLL_POSITIONS_KEY = 'fileScrollPositions';

const scrollDebounce = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pending: ScrollAnchor | null }>();

function scrollSlot(path: string) {
    let slot = scrollDebounce.get(path);
    if (!slot) { slot = { timer: null, pending: null }; scrollDebounce.set(path, slot); }
    return slot;
}

let legacyScrollPositionsDropped = false;

function scrollAnchorRecord(): Record<string, unknown> {
    if (!legacyScrollPositionsDropped) {
        legacyScrollPositionsDropped = true;
        removeStoredValue(LEGACY_SCROLL_POSITIONS_KEY);
    }
    return readRecord<unknown>(SCROLL_ANCHORS_KEY);
}

function flushScroll(path: string): void {
    const slot = scrollDebounce.get(path);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.pending !== null) {
        const { pos, offset } = slot.pending;
        scrollAnchorRecord()[scopedKey(path)] = { pos, offset: Math.round(offset * 10) / 10 };
        flushRecord(SCROLL_ANCHORS_KEY);
        slot.pending = null;
    }
    scrollDebounce.delete(path);
}

function armScrollFlush(path: string): void {
    const slot = scrollSlot(path);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => { slot.timer = null; flushScroll(path); }, 300);
}

function rememberScroll(path: string, view: EditorView): void {
    if (isHoldingScrollAnchor(view)) return;
    captureScrollAnchor(view, `scroll-anchor:${path}`, (anchor) => {
        scrollSlot(path).pending = anchor;
        armScrollFlush(path);
    });
}

function rememberedScroll(path: string): ScrollAnchor | null {
    const pending = scrollDebounce.get(path)?.pending;
    if (pending) return pending;
    const stored = scrollAnchorRecord()[scopedKey(path)];
    return isScrollAnchor(stored) ? stored : null;
}

function mapRememberedScroll(path: string, changes: ChangeDesc): void {
    const current = rememberedScroll(path);
    if (!current) return;
    const mapped = mapScrollAnchor(current, changes);
    if (mapped === current) return;
    scrollSlot(path).pending = mapped;
    armScrollFlush(path);
}

const COLLAPSED_HEADINGS_KEY = 'collapsedHeadings';

const foldDebounce = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pending: EditorState | null }>();

function flushFolds(path: string): void {
    const slot = foldDebounce.get(path);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.pending) {
        const record = readRecord<HeadingKey[]>(COLLAPSED_HEADINGS_KEY);
        const key = scopedKey(path);
        const keys = foldedHeadingKeys(slot.pending);
        if (!sameHeadingKeys(record[key], keys)) {
            if (keys.length > 0) record[key] = keys;
            else delete record[key];
            flushRecord(COLLAPSED_HEADINGS_KEY);
        }
        slot.pending = null;
    }
    foldDebounce.delete(path);
}

const unsubscribeViewRetarget = subscribeDocumentViewRetarget(from => { flushScroll(from); flushFolds(from); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeViewRetarget);

function rememberFolds(path: string, state: EditorState): void {
    let slot = foldDebounce.get(path);
    if (!slot) { slot = { timer: null, pending: null }; foldDebounce.set(path, slot); }
    const armed = slot;
    armed.pending = state;
    if (armed.timer) clearTimeout(armed.timer);
    armed.timer = setTimeout(() => { armed.timer = null; flushFolds(path); }, 400);
}

function storedFoldKeys(path: string): readonly HeadingKey[] {
    const keys = readRecord<unknown>(COLLAPSED_HEADINGS_KEY)[scopedKey(path)];
    return isHeadingKeyList(keys) ? keys : [];
}

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const indentCompartment = new Compartment();


function themeExtensions(theme: Theme, code = false) {
    const light = theme === 'light';
    if (code) return [light ? obsidianLightTheme : obsidianDarkTheme, light ? codeLightTheme : codeDarkTheme];
    return light
        ? [obsidianLightTheme, obsidianLightHighlightStyle]
        : [obsidianDarkTheme, obsidianHighlightStyle];
}

function keyIsForNote(event: KeyboardEvent, view: EditorView): boolean {
    if (!event.metaKey && !event.ctrlKey && event.key !== 'F3') return false;
    if (event.defaultPrevented || event.isComposing) return false;
    if (document.querySelector('[aria-modal="true"]')) return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (view.dom.contains(target)) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return false;
    return !target.closest('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]');
}

function lineCol(state: EditorState, pos: number): LineCol {
    const line = state.doc.lineAt(pos);
    return { line: line.number, col: pos - line.from + 1 };
}

function describeMarkdown(view: EditorView, mode: EditorMode, dirty: boolean, language?: string): MarkdownViewInfo {
    const { state } = view;
    const doc = state.doc;
    let from = view.viewport.from;
    let to = view.viewport.to;
    const box = view.scrollDOM.getBoundingClientRect();
    if (box.height > 0) {
        from = view.lineBlockAtHeight(Math.max(0, box.top - view.documentTop)).from;
        to = view.lineBlockAtHeight(Math.max(0, box.bottom - view.documentTop - 1)).to;
    }
    from = Math.min(Math.max(0, from), doc.length);
    to = Math.min(Math.max(from, to), doc.length);
    const head = state.selection.main.head;
    const selections = state.selection.ranges
        .filter(r => !r.empty)
        .map(r => ({ from: r.from, to: r.to, fromLC: lineCol(state, r.from), toLC: lineCol(state, r.to) }))
        .sort((a, b) => a.from - b.from);
    return {
        kind: 'markdown',
        mode,
        text: docString(doc),
        lineCount: doc.lines,
        visibleLines: { from: doc.lineAt(from).number, to: doc.lineAt(to).number },
        visibleRange: { from: doc.lineAt(from).from, to: doc.lineAt(to).to },
        cursor: lineCol(state, head),
        cursorOffset: head,
        selections,
        dirty,
        language,
    };
}

function applyAgentChanges(view: EditorView, changes: readonly TextChange[]): void {
    const length = view.state.doc.length;
    const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
    let end = 0;
    for (const change of sorted) {
        const { from, to, insert } = change;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
            throw new RangeError(`Edit range ${from}..${to} is outside the note (0..${length})`);
        }
        if (typeof insert !== 'string') throw new RangeError('Edit insert must be a string');
        if (from < end) throw new RangeError(`Edit ranges overlap at ${from}`);
        end = to;
    }
    view.dispatch({
        changes: sorted.map(({ from, to, insert }) => ({ from, to, insert })),
        userEvent: 'input.agent',
        annotations: isolateHistory.of('full'),
    });
}

const READ_MODE_REASON = 'Switch to editing with ⌘E';
const NO_SELECTION_REASON = 'Nothing is selected';


function editorMenuEntries(view: EditorView, notify: (message: string) => void): ContextMenuEntry[] {
    const editable = canWrite(view.state);
    const empty = view.state.selection.main.empty;

    return [
        {
            kind: 'command',
            id: 'cut',
            label: 'Cut',
            disabled: !editable || empty,
            reason: !editable ? READ_MODE_REASON : empty ? NO_SELECTION_REASON : undefined,
            run: async () => {
                const range = view.state.selection.main;
                if (range.empty) return;
                // The text goes ONLY after the clipboard write resolves: a
                // refused clipboard that had already deleted the selection
                // would have destroyed it and put it nowhere.
                if (!await copyText(view.state.sliceDoc(range.from, range.to))) {
                    notify(CLIPBOARD_WRITE_BLOCKED);
                    return;
                }
                const now = view.state.selection.main;
                if (now.empty || !canWrite(view.state)) return;
                view.dispatch({ changes: { from: now.from, to: now.to, insert: '' }, selection: { anchor: now.from } });
                view.focus();
            },
        },
        {
            kind: 'command',
            id: 'copy',
            label: 'Copy',
            disabled: empty,
            reason: empty ? NO_SELECTION_REASON : undefined,
            run: async () => {
                const range = view.state.selection.main;
                if (range.empty) return;
                if (!await copyText(view.state.sliceDoc(range.from, range.to))) {
                    notify(CLIPBOARD_WRITE_BLOCKED);
                }
            },
        },
        {
            kind: 'command',
            id: 'paste',
            label: 'Paste',
            disabled: !editable,
            reason: !editable ? READ_MODE_REASON : undefined,
            run: async () => {
                const read = await readClipboardText();
                if (!read.ok) { notify(CLIPBOARD_READ_BLOCKED); return; }
                if (!canWrite(view.state)) return;
                const range = view.state.selection.main;
                view.dispatch({
                    changes: { from: range.from, to: range.to, insert: read.text },
                    selection: { anchor: range.from + read.text.length },
                    scrollIntoView: true,
                });
                view.focus();
            },
        },
        {
            kind: 'command',
            id: 'select-all',
            label: 'Select all',
            run: () => {
                view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
                view.focus();
            },
        },
        { kind: 'separator', id: 'sep-insert' },
        {
            kind: 'grid',
            id: 'insert-table',
            label: 'Insert table…',
            maxRows: TABLE_GRID_ROWS,
            maxCols: TABLE_GRID_COLS,
            disabled: !editable,
            reason: !editable ? READ_MODE_REASON : undefined,
            pick: (rows, cols) => { insertTableAtCursor(view, rows, cols); },
        },
    ];
}

interface DocumentPaneProps {
    reading: ReaderIntegration;
    tab: OpenTab;
    paneId: string;
    isFocused: boolean;
    isSplit: boolean;
    canBack: boolean;
    canForward: boolean;
    onBack: (paneId: string) => void;
    onForward: (paneId: string) => void;
    onClosePane: (paneId: string) => void;
    onToggleMode: (path: string) => void;
    onExportNotebook: (file: ActiveFile) => void;
    widthStyle: React.CSSProperties;
    theme: Theme;
    tabSize: number;
    rainbowBrackets: boolean;
    contentOf(path: string): string | undefined;
    documentBuffers: DocumentBufferStore;
    markdownSessions: MarkdownSessionHost;
    registerKeyboardTarget: (path: string, take: () => void) => () => void;
    /** Baked into the EditorState, which outlives this pane and EditorPane
     *  both, so the caller keeps it stable for the app's life (App does). */
    getWikiLinkTargets: () => WikiLinkTarget[];
    onContentChange: (path: string, content: string, options?: ContentChangeOptions) => void;
    onDiskAction: (path: string, action: DiskAction) => Promise<void>;
    onRetryRead: (path: string) => Promise<boolean>;
    onFocusPane: (path: string) => void;
    onOpenNote: OpenNoteByNameHandler;
    onNotify: (message: string) => void;
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

function TexDocument({ store, documentId, path, contentOf }: { store: DocumentBufferStore; documentId: string; path: string; contentOf(path: string): string | undefined }) {
    useDocumentRevision(store, documentId);
    const text = contentOf(path);
    return text === undefined ? null : <TexView source={text} />;
}

function DocumentPane({
    tab,
    paneId,
    isFocused,
    isSplit,
    canBack,
    canForward,
    widthStyle,
    theme,
    tabSize,
    rainbowBrackets,
    contentOf,
    documentBuffers,
    markdownSessions,
    registerKeyboardTarget,
    getWikiLinkTargets,
    onContentChange,
    onDiskAction,
    onRetryRead,
    onFocusPane,
    onBack,
    onForward,
    onClosePane,
    onToggleMode,
    onExportNotebook,
    onOpenNote,
    onNotify,
    onConfirm,
    revealRequest,
    onRevealHandled,
    reading,
}: DocumentPaneProps) {
    const { getAssetUrl, saveAsset } = useFileSystem();

    const file = tab.file;
    const path = file.path;
    const documentId = tab.id;
    const mode = tab.mode;
    const isDrawing = !file.isHelp && tab.representation.loadedKind === 'drawing';
    const isNotebook = !file.isHelp && isNotebookFile(file.name);
    const isPdf = !file.isHelp && tab.representation.loadedKind === 'pdf';
    const isEpub = !file.isHelp && tab.representation.loadedKind === 'epub';
    const isCanvas = isDrawing || isNotebook || isPdf || isEpub;
    const isTex = !file.isHelp && isTexFile(file.name);
    const isCode = !file.isHelp && isCodeFile(file.name);
    const codeLanguage: CodeLanguage | null = isCode ? codeLanguageFor(file.name) : null;
    /** Restored without its text (OpenTab.readError): this pane shows only
     *  that, and builds no view, drawing or notebook — each would take the
     *  empty buffer for the document and save it over the file. */
    const unsupported = tab.representation.loadedKind === 'unsupported';
    const unreadable = !!tab.readError || (!isCanvas && !canReadTabText(tab));
    const preferences = useSyncExternalStore(subscribeReadingPreferences,getReadingPreferences);
    const readerIdentity = reading.identityForTab(tab);
    const controller = useSyncExternalStore(useCallback(listener => subscribeReadingSurface(tab.id, listener), [tab.id]), useCallback(() => getReadingSurface(readerIdentity), [readerIdentity]));
    const capability = readingCapabilities(tab, controller?.capabilities() ?? tab.readerCapabilities).emphasis;
    const texReading = isTex && mode === 'read' && !unreadable;
    const [retrying, setRetrying] = useState(false);
    // A success remounts this pane (EditorPane keys it on readError), so only a
    // failed attempt comes back to a mounted component to clear the flag.
    const retryRead = async () => {
        setRetrying(true);
        if (!await onRetryRead(path)) setRetrying(false);
    };

    const viewRef = useRef<EditorView | null>(null);
    const detachViewRef = useRef<(() => void) | undefined>(undefined);
    const destroyView = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        cancelReadingConfiguration(view);
        cancelWordReadingAnchor(view);
        detachViewRef.current?.();
        detachViewRef.current = undefined;
        view.destroy();
        viewRef.current = null;
    }, []);
    // TeX read mode swaps the container without unmounting this pane. A ref's
    // transient null on an ordinary re-render must not destroy the live view.
    useLayoutEffect(() => { if (texReading) destroyView(); }, [texReading, destroyView]);
    const buildingViewRef = useRef(false);

    const isFocusedRef = useRef(isFocused);
    useEffect(() => { isFocusedRef.current = isFocused; }, [isFocused]);
    useEffect(() => onTableInsertRequest((request) => {
        const view = viewRef.current;
        if (!view || !isFocusedRef.current || request.path !== tab.file.path) return;
        insertTableAtCursor(view, request.rows, request.cols);
    }), [tab.file.path]);

    useEffect(() => {
        if (isCanvas) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const view = viewRef.current;
            if (!view || !isFocusedRef.current || !keyIsForNote(event, view)) return;
            runNoteSearchKey(view, event);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isCanvas]);

    useEffect(() => {
        if (!isPdf && !isEpub) return;
        const key = (event: KeyboardEvent) => {
            if (!isFocusedRef.current || event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
            const target = event.target;
            if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [data-agent-panel], [data-terminal]') || document.querySelector('[aria-modal="true"]')) return;
            const surface = controller?.capabilities().surface;
            if ((!isEpub && surface !== 'pdf-text' && surface !== 'pdf-original') || !controller?.findReading) return;
            event.preventDefault(); controller.findReading();
        };
        window.addEventListener('keydown', key);
        return () => window.removeEventListener('keydown', key);
    }, [isPdf, isEpub, controller]);

    const texScrollerRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (isCanvas || unreadable) return;
        return registerKeyboardTarget(path, () => (texReading
            ? texScrollerRef.current?.focus({ preventScroll: true })
            : viewRef.current?.scrollDOM.focus({ preventScroll: true })));
    }, [path, isCanvas, unreadable, texReading, registerKeyboardTarget]);

    const revealClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const tabRef = useRef(tab);
    useEffect(() => { tabRef.current = tab; }, [tab]);
    const isHelp = !!file.isHelp;
    useEffect(() => {
        if (isCanvas || unreadable || contentOf(path) === undefined) return;
        const text = () => {
            const view = viewRef.current;
            const current = view ? docString(view.state.doc) : contentOf(path);
            if (current === undefined) throw new Error('Document text is unavailable.');
            return current;
        };
        return registerView(path, {
            kind: 'markdown',
            describe() {
                const view = viewRef.current;
                const { mode: tabMode, dirty } = tabRef.current;
                if (view) return describeMarkdown(view, tabMode, !!dirty, codeLanguage?.name);
                const content = text();
                const state = EditorState.create({ doc: content });
                return {
                    kind: 'markdown', mode: tabMode, text: content, lineCount: state.doc.lines,
                    visibleLines: { from: 1, to: 1 }, visibleRange: { from: 0, to: state.doc.line(1).to },
                    cursor: { line: 1, col: 1 }, cursorOffset: 0, selections: [], dirty: !!dirty,
                    language: codeLanguage?.name,
                };
            },
            getText: text,
            ...(isHelp ? {} : {
                applyTextChanges(changes: TextChange[]) {
                    const view = viewRef.current;
                    if (!view) return false;
                    applyAgentChanges(view, changes);
                    return true;
                },
                replaceFromDisk(next: string) {
                    const view = viewRef.current;
                    if (!view) return false;
                    const spec = reloadSpec(view.state, next);
                    if (spec) view.dispatch(spec);
                    return true;
                },
            }),
        });
    }, [path, isCanvas, unreadable, isHelp, codeLanguage?.name, contentOf]);

    const [stableGetAssetUrl] = useState(() => (fileName: string) =>
        getAssetUrl(fileName, markdownSessions.parentHandleOf(documentId)));

    const [imageActions] = useState<ImageEmbedActions>(() => ({
        confirmDelete: (request) => {
            const adapter = markdownSessions.get(documentId), doc = adapter?.state.doc;
            void onConfirm({ title: 'Remove image?', body: `${request.name} is removed from this note, and its file moves to .Garbage if no other note uses it. You can undo this.`, confirmLabel: 'Remove', danger: true }).then(confirmed => {
                if (confirmed && adapter && markdownSessions.get(documentId) === adapter && adapter.state.doc === doc) request.run();
            });
        },
    }));

    const [imageContexts] = useState(() => ({
        read: { getAssetUrl: stableGetAssetUrl, actions: imageActions, editable: false },
        edit: { getAssetUrl: stableGetAssetUrl, actions: imageActions, editable: true },
    }));
    const livePreviewFor = useCallback((forMode: EditorMode) =>
        (isTex || isCode ? [] : createLivePreviewPlugin(imageContexts[forMode], imageActions)),
    [isTex, isCode, imageContexts, imageActions]);

    const metadataUpdate = (update: MarkdownSessionUpdate) => {
        const currentPath = markdownSessions.pathOf(documentId);
        if (currentPath === undefined) return;
        if (update.docChanged) {
            const words = update.state.field(wordCountField, false);
            if (words !== undefined) publishWordCounts(currentPath, { words, chars: update.state.doc.length });
            mapRememberedScroll(currentPath, update.changes);
        }
        const before = update.startState.field(headingFoldField, false);
        const after = update.state.field(headingFoldField, false);
        if (before && after && (before.folded !== after.folded || (
            update.docChanged && before.folded.length > 0
            && update.changes.touchesRange(0, update.startState.doc.lineAt(before.folded[before.folded.length - 1]).to) !== false
        ))) rememberFolds(currentPath, update.state);
    };
    const editorExtensions = (): Extension => [
            ...(isCode ? codeExtensions({ tabSize, language: codeLanguage, rainbow: rainbowBrackets }) : [
                EditorView.lineWrapping,
                drawSelection(),
                history(),
            mathEditingExtensions(),
            closeBrackets(),
            markdown({
                base: markdownLanguage,
                codeLanguages: (info: string) =>
                    LanguageDescription.matchLanguageName(languages, info, true)
                    ?? LanguageDescription.matchFilename(languages, `x.${info}`),
            }),
                indentCompartment.of(indentSettings(tabSize)),
                listIndentKeymap,
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...closeBracketsKeymap,
                    ...searchKeymap,
                ]),
            ]),
            themeCompartment.of(themeExtensions(theme, isCode)),
            search({ scrollToMatch: revealMatchEffect, createPanel: findPanel(revealMatchEffect), top: true }),
            noteSearchKeymap,
            keyboardAfterSearchClose,
            readOnlyCompartment.of(modeExtensions(mode)),
            ...(!isCode && !isTex ? [readingEmphasis, readingEmphasisCompartment.of(readingEmphasisOptions({enabled: getReadingPreferences().emphasis.enabled, mode, locale: ''}))] : []),
            ...(isCode ? [] : [
                tabIntoText,
                wikiLinkAutocomplete(getWikiLinkTargets),
                ...(isTex ? [] : [docAnalysisField, livePreviewField]),
                livePreviewCompartment.of(livePreviewFor(mode)),
                // Deliberately OUTSIDE livePreviewCompartment: ⌘E reconfigures
                // that, which would forget every collapsed section (headingFold.ts).
                headingFold(storedFoldKeys(markdownSessions.pathOf(documentId) ?? path)),
            ]),
            // Outside every compartment for the same reason: a reconfigure
            // (⌘E, the theme) must not drop a restored place still being held.
            scrollAnchorTracking,
            ...(isCode ? [] : [markdownFormatExtension]),
            revealHighlightField,
            ...(isCode ? [] : [wordCountField]),
            EditorView.updateListener.of(update => markdownSessions.get(documentId)?.observe(update)),
            EditorView.domEventHandlers({
                paste(event, view) {
                    const items = event.clipboardData?.items;
                    if (!items || !canWrite(view.state)) return false;

                    for (const item of items) {
                        if (item.type.startsWith('image/')) {
                            event.preventDefault();
                            const blob = item.getAsFile();

                            const now = new Date();
                            const timestamp = now.getFullYear().toString() +
                                (now.getMonth() + 1).toString().padStart(2, '0') +
                                now.getDate().toString().padStart(2, '0') +
                                now.getHours().toString().padStart(2, '0') +
                                now.getMinutes().toString().padStart(2, '0') +
                                now.getSeconds().toString().padStart(2, '0');

                            const extMatch = item.type.match(/image\/(jpeg|png|gif|webp|svg\+xml)/);
                            let ext = '.png';
                            if (extMatch) {
                                ext = `.${extMatch[1] === 'svg+xml' ? 'svg' : extMatch[1]}`;
                            }
                            const filename = `Pasted image ${timestamp}${ext}`;

                            const currentPath = markdownSessions.pathOf(documentId);
                            if (currentPath === undefined || !blob) return true;
                            const parentHandle = markdownSessions.parentHandleOf(documentId);
                            const folder = parentVaultPath(currentPath);
                            const assetFolder = joinVaultPath(folder, ASSETS_DIR);
                            const adapter = markdownSessions.get(documentId);
                            saveAsset(filename, blob, parentHandle).then(() => {
                                // A move during the write must not insert a reference
                                // to a picture saved beside the old destination.
                                if (!adapter || markdownSessions.get(documentId) !== adapter) return;
                                const latestPath = markdownSessions.pathOf(documentId);
                                if (latestPath === undefined) return;
                                if (parentVaultPath(latestPath) !== folder) {
                                    onNotify('The note moved while its picture was saving. Paste it again in the new folder.');
                                    return;
                                }
                                const insertText = `![[${filename}]]\n`;
                                const ranges = adapter.state.selection.ranges;
                                if (ranges.length > 0) {
                                    const pos = ranges[0].from;
                                    adapter.dispatch({
                                        changes: { from: pos, insert: insertText },
                                        selection: { anchor: pos + insertText.length }
                                    });
                                }
                            }).catch(err => {
                                console.error('Failed to save pasted image:', err);
                                onNotify(`Could not save the pasted image to “${assetFolder}”. Check that this is a writable folder, then try again.`);
                            });

                            return true;
                        }
                    }
                    return false;
                },
                scroll(event, view) {
                    const currentPath = markdownSessions.pathOf(documentId);
                    if (currentPath !== undefined) rememberScroll(currentPath, view);
                },
                drop(event) {
                    const item = event.dataTransfer?.items?.[0];
                    return item?.kind === 'file' && !!item.getAsFile()?.name.endsWith('.md');
                },
                mousedown(event) {
                    const el = (event.target as HTMLElement).closest?.('.cm-wikilink');
                    if (el) {
                        event.preventDefault();
                        onOpenNote(el.getAttribute('data-wikilink') as string);
                        return true;
                    }
                    return false;
                }
            })
        ];

    const setEditorContainer = (node: HTMLDivElement | null, retried = false) => {
        if (!node || viewRef.current) return;
        const cached = markdownSessions.get(documentId);
        const keyboardBefore = document.activeElement;
        buildingViewRef.current = true;
        try {
            const initial = contentOf(path);
            if (initial === undefined) return;
            const adapter = markdownSessions.ensure(documentId, owner => createMarkdownSession(owner,
                EditorState.create({ doc: initial, extensions: history() }), () => documentBuffers.get(documentId)?.source));
            if (!adapter) {
                // A note opened this very commit is not in App's tab mirror yet:
                // App publishes it from a layout effect, and a child's ref runs
                // before any parent layout effect, so the session host refuses
                // the unknown id. Once more after the commit, still before paint
                // (measured: in production, without StrictMode's second ref call,
                // every newly opened note drew an empty pane until a tab switch).
                if (!retried) queueMicrotask(() => setEditorContainer(node, true));
                return;
            }
            adapter.configure(editorExtensions(), metadataUpdate);
            const view = new EditorView({ state: adapter.state, parent: node });
            detachViewRef.current = adapter.attach(view);
            viewRef.current = view;
            if (initial.includes('$')) warmMath();
            returnKeyboard(view, keyboardBefore);
            if (isCode) void loadCodeLanguage(view, codeLanguage, codeLanguage === null);

            if (cached) {
                const restoreSelection = captureReadingSelection(view);
                if (restoreSelection) queueTableReadingSelection(view, restoreSelection);
                const wasReadOnly = view.state.readOnly;
                if (__BME_BENCH__) { if (!isCode && !isTex && wasReadOnly !== (mode === 'read')) markEditorModeRender(); }
                view.dispatch({
                    effects: [
                        themeCompartment.reconfigure(themeExtensions(theme, isCode)),
                        readOnlyCompartment.reconfigure(modeExtensions(mode)),
                        livePreviewCompartment.reconfigure(livePreviewFor(mode)),
                        indentCompartment.reconfigure(indentSettings(tabSize)),
                        ...(!isCode && !isTex ? [readingEmphasisCompartment.reconfigure(readingEmphasisOptions({enabled: preferences.emphasis.enabled, mode, locale: ''}))] : []),
                        setRevealHighlight.of(null),
                    ],
                });
            }

            const anchor = rememberedScroll(path);
            if (anchor) holdScrollAnchor(view, anchor);
        } finally {
            buildingViewRef.current = false;
        }
    };

    useEffect(() => () => {
        destroyView();
        const currentPath = markdownSessions.pathOf(documentId);
        if (currentPath !== undefined) { flushScroll(currentPath); flushFolds(currentPath); }
        if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
    }, [documentId, markdownSessions, destroyView]);

    const settled = useRef(false);
    const previousCodeLanguage = useRef(codeLanguage?.description);
    useEffect(() => {
        if (previousCodeLanguage.current === codeLanguage?.description) return;
        previousCodeLanguage.current = codeLanguage?.description;
        const view = viewRef.current;
        if (view && isCode) void loadCodeLanguage(view, codeLanguage, true);
    }, [codeLanguage, isCode]);

    useEffect(() => {
        if (!settled.current) return;
        viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme, isCode)) });
    }, [theme, isCode]);

    useEffect(() => {
        if (!settled.current || !isCode) return;
        viewRef.current?.dispatch({
            effects: bracketColourCompartment.reconfigure(rainbowBrackets ? rainbowBracketsExtension : []),
        });
    }, [rainbowBrackets, isCode]);

    useEffect(() => {
        if (!settled.current) return;
        viewRef.current?.dispatch({ effects: indentCompartment.reconfigure(indentSettings(tabSize)) });
    }, [tabSize]);

    const readingConfigRevision = useRef(0);
    useEffect(() => {
        if (!settled.current) return;
        const view = viewRef.current;
        if (!view) return;
        const revision = ++readingConfigRevision.current;
        deferReadingConfiguration(view, () => {
            void captureWordReadingAnchor(view).then(anchor => {
                if (viewRef.current !== view || revision !== readingConfigRevision.current) return;
                const restoreSelection = captureReadingSelection(view);
                if (restoreSelection) queueTableReadingSelection(view, restoreSelection);
                const wasReadOnly = view.state.readOnly;
                const modeChanged = wasReadOnly !== (mode === 'read');
                if (__BME_BENCH__) { if (modeChanged && !isCode && !isTex) markEditorModeRender(); }
                view.dispatch({ effects: [
                    ...(modeChanged ? [readOnlyCompartment.reconfigure(modeExtensions(mode)),livePreviewCompartment.reconfigure(livePreviewFor(mode))] : []),
                    ...(!isCode && !isTex ? [readingEmphasisCompartment.reconfigure(readingEmphasisOptions({enabled: preferences.emphasis.enabled, mode, locale: ''}))] : []),
                ] });
                if (anchor) restoreWordReadingAnchor(view, anchor);
                restoreSelection?.();
            });
        });
        return () => { if (readingConfigRevision.current === revision) readingConfigRevision.current = revision + 1; cancelReadingConfiguration(view); cancelWordReadingAnchor(view); };
    }, [mode, livePreviewFor, preferences.emphasis.enabled, isCode, isTex]);

    // Declared LAST on purpose — effects run in declaration order, so the three
    // above see `false` on the mount pass and `true` on every pass after it. The
    // cleanup makes StrictMode's simulated remount behave like a real one: it
    // re-runs the ref callback too, so that build configures the view just the
    // same and the three should skip again.
    useEffect(() => {
        settled.current = true;
        return () => { settled.current = false; };
    }, []);

    useEffect(() => {
        if (!revealRequest || revealRequest.path !== path) return;
        const { from, to } = revealRequest;
        onRevealHandled();

        requestAnimationFrame(() => {
            const view = viewRef.current;
            if (!view) return;
            const docLen = view.state.doc.length;
            const safeFrom = Math.min(from, docLen);
            const safeTo = Math.min(to, docLen);
            parseForReveal(view, safeTo);
            view.dispatch({
                selection: { anchor: safeFrom, head: safeTo },
                effects: [
                    revealMatch.of({ from: safeFrom, to: safeTo }),
                    setRevealHighlight.of({ from: safeFrom, to: safeTo }),
                ],
            });
            view.focus();

            if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
            revealClearTimerRef.current = setTimeout(() => {
                viewRef.current?.dispatch({ effects: setRevealHighlight.of(null) });
            }, 1600);
        });
        // No effect cleanup: it would cancel the pending fade when
        // onRevealHandled() nulls the request and re-runs this effect.
    }, [revealRequest, path, onRevealHandled]);

    const takeFocus = () => { if (!isFocused) onFocusPane(path); };
    const takeFocusFromEvent = () => { if (!buildingViewRef.current) takeFocus(); };

    const displayName = noteDisplayName(file.name);

    const canAnnotate = isPdf && !unreadable;
    const canToggleRead = !file.isHelp && !isCanvas && !unreadable;
    const canToggleMode = canAnnotate || canToggleRead;
    const modeTitle = canAnnotate
        ? (mode === 'read' ? 'Viewing — switch to annotating (⌘E)' : 'Annotating — switch to viewing (⌘E)')
        : (mode === 'read' ? 'Reading — switch to edit (⌘E)' : 'Editing — switch to reading (⌘E)');
    const modeIcon = canAnnotate
        ? (mode === 'read' ? <PenTool size={15} /> : <Eye size={15} />)
        : (mode === 'read' ? <Eye size={15} /> : <Edit2 size={15} />);

    const announce = (verb: string) => (isSplit ? `${verb} in ${displayName}` : verb);

    const openPaneMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
        // FIRST, and load-bearing: the table-insert listener above is gated on
        // `isFocused`, so a ⋯ raised in a pane that does not have focus would
        // publish its pick into nothing — a row that silently does nothing at
        // all. Focusing is also just what acting on a pane means.
        takeFocus();
        const button = event.currentTarget;
        const box = button.getBoundingClientRect();
        const entries: ContextMenuEntry[] = [
            {kind:'command',id:'word-emphasis',label:'Word emphasis',checked:capability.kind==='toggle' && preferences.emphasis.enabled,disabled:capability.kind==='inactive',reason:capability.kind==='inactive'?capability.reason:undefined,run:()=>{if(capability.kind==='toggle')setWordEmphasis(!getReadingPreferences().emphasis.enabled)}},
        ];
        if (isEpub && controller?.showBookPanel) entries.push(
            {kind:'command',id:'book-contents',label:'Book contents',run:()=>controller.showBookPanel?.('contents')},
            {kind:'command',id:'book-find',label:'Find in book',run:()=>controller.showBookPanel?.('search')},
            {kind:'command',id:'book-appearance',label:'Reading appearance',run:()=>controller.showBookPanel?.('appearance')},
            ...(['scroll','pages'] as const).map(flow=>({kind:'command' as const,id:`book-${flow}`,label:flow==='scroll'?'Scroll layout':'Pages layout',checked:controller.bookFlow?.()===flow,disabled:controller.capabilities().surface==='epub-fixed',reason:controller.capabilities().surface==='epub-fixed'?'Publisher page geometry is preserved':undefined,run:()=>controller.setBookFlow?.(flow)})),
        );
        if (isPdf && mode === 'read' && controller) entries.push(
            {kind:'command',id:'pdf-text',label:'Read extracted text',checked:controller.capabilities().surface==='pdf-text',disabled:!controller.showPdfText || tab.readerStatus?.phase==='loading' || !!tab.disk || tab.dirty,reason:tab.disk?'Resolve the PDF disk change first':tab.dirty?'Wait for annotations to finish saving':undefined,run:()=>{void controller.showPdfText?.().catch(error=>onNotify(String(error)))}},
            {kind:'command',id:'pdf-original',label:'Original PDF',checked:controller.capabilities().surface==='pdf-original',run:()=>{void controller.showPdfOriginal?.().catch(error=>onNotify(String(error)))}},
            ...(controller.printPdf ? [{kind:'command' as const,id:'pdf-print',label:'Print…',run:()=>controller.printPdf?.()}] : []),
        );
        if(canToggleMode) entries.push({kind:'command',id:'change-mode',label: canAnnotate ? 'Toggle view/annotate mode' : 'Toggle read/edit mode',run:()=>onToggleMode(path)});
        if (canToggleRead && !isTex && !isCode) {
            entries.push({
                kind: 'grid',
                id: 'insert-table',
                label: 'Insert table…',
                maxRows: TABLE_GRID_ROWS,
                maxCols: TABLE_GRID_COLS,
                disabled: mode === 'read',
                reason: mode === 'read' ? 'Switch to editing (⌘E) to insert a table' : undefined,
                pick: (rows, cols) => { requestTableInsert(path, rows, cols); },
            });
        }
        if (isNotebook && !unreadable) {
            entries.push({
                kind: 'command',
                id: 'export-pdf',
                label: 'Export to PDF',
                run: () => onExportNotebook(file),
            });
        }
        if (entries.length > 0) entries.push({ kind: 'separator', id: 'sep-pane' });
        entries.push({
            kind: 'command',
            id: 'close-pane',
            label: 'Close this pane',
            run: () => onClosePane(paneId),
        });
        openContextMenu({
            x: box.left,
            y: box.bottom,
            label: 'Pane actions',
            opener: button,
            anchor: button,
            entries,
        });
    };

    return (
        <div
            className={`editor-slot${isFocused ? ' is-focused' : ''}`}
            style={widthStyle}
            onMouseDownCapture={takeFocus}
            onFocusCapture={takeFocusFromEvent}
        >
            <div
                className="editor-slot-header"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => e.preventDefault()}
            >
                <div className="editor-slot-nav">
                    <button className="editor-slot-action editor-history-menu" aria-label="Document history" aria-haspopup="menu" data-tooltip="Document history" onClick={event=>{const button=event.currentTarget,box=button.getBoundingClientRect();openContextMenu({x:box.left,y:box.bottom,label:'Document history',opener:button,entries:[{kind:'command',id:'back',label:'Back',disabled:!canBack,reason:canBack?undefined:'No previous document',run:()=>onBack(paneId)},{kind:'command',id:'forward',label:'Forward',disabled:!canForward,reason:canForward?undefined:'No next document',run:()=>onForward(paneId)}]})}}>↔</button>
                    <button
                        className="editor-slot-action"
                        disabled={!canBack}
                        data-tooltip="Back"
                        aria-label={announce('Back')}
                        onClick={() => onBack(paneId)}
                    >
                        <ArrowLeft size={15} />
                    </button>
                    <button
                        className="editor-slot-action"
                        disabled={!canForward}
                        data-tooltip="Forward"
                        aria-label={announce('Forward')}
                        onClick={() => onForward(paneId)}
                    >
                        <ArrowRight size={15} />
                    </button>
                </div>
                <span className="editor-slot-title" data-tooltip={path}>{displayName}</span>
                {tab.dirty && <span className="editor-slot-dot" aria-hidden="true" />}
                <div className="editor-slot-actions">
                    <WordEmphasisToggle className="editor-slot-action" capability={capability} />
                    {canToggleMode && (
                        <button
                            className="editor-slot-action editor-mode-toggle"
                            data-tooltip={modeTitle}
                            aria-label={announce(canAnnotate ? 'Toggle view/annotate mode' : 'Toggle read/edit mode')}
                            onClick={() => onToggleMode(path)}
                        >
                            {modeIcon}
                        </button>
                    )}
                    <button
                        className="editor-slot-action"
                        data-tooltip="More options"
                        aria-label={announce('More options')}
                        aria-haspopup="menu"
                        onClick={openPaneMenu}
                    >
                        <MoreHorizontal size={15} />
                    </button>
                </div>
            </div>
            {tab.disk && (!isCanvas || isEpub) && (
                <DiskBar readOnly={isEpub || !canReadTabText(tab)} name={file.name} state={tab.disk} unsaved={tab.dirty} path={path} onAction={onDiskAction} />
            )}
            <div className="editor-slot-body">
                {isEpub && <EpubReaderHost key={`${readerIdentity.vaultId}|${readerIdentity.vaultEpoch}|${tab.id}|${readerIdentity.byteGeneration}`} identity={readerIdentity} integration={reading} isFocused={isFocused} onFocusPane={onFocusPane} onRetryRead={onRetryRead} registerKeyboardTarget={registerKeyboardTarget} theme={theme} />}
                {unreadable && (
                    <div
                        className="pdf-pane-message unread-pane"
                        role="status"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    >
                        <span className="unread-pane-title" data-tooltip={file.name}>
                            {unsupported ? 'Can’t open ' : 'Couldn’t read '}<strong>{file.name}</strong>
                        </span>
                        <span className="unread-pane-hint">
                            {unsupported
                                ? 'This file’s format is not supported by this build. Nothing was changed, and its tab is kept.'
                                : file.isHelp
                                    ? 'The guide is downloaded with the app, and it could not be just now. Its tab is kept.'
                                    : 'Another program may be using it, it may not be downloaded yet, or it can’t be opened right now. Nothing was changed, and its tab is kept.'}
                        </span>
                        <span className="unread-pane-detail" data-tooltip={tab.readError}>{tab.readError}</span>
                        {!unsupported && (
                            <button className="pdf-pane-action" disabled={retrying} onClick={retryRead}>
                                {retrying ? 'Trying…' : 'Try again'}
                            </button>
                        )}
                    </div>
                )}
                {texReading && (
                    <div
                        className="tex-slot"
                        ref={texScrollerRef}
                        tabIndex={-1}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    >
                        <TexDocument store={documentBuffers} documentId={tab.id} path={path} contentOf={contentOf} />
                    </div>
                )}
                {!isCanvas && !unreadable && !texReading && (
                    <div
                        className={`view-content${isCode ? ' is-code' : ''}`}
                        ref={setEditorContainer}
                        onContextMenu={(e) => {
                            const view = viewRef.current;
                            if (!view) return;
                            e.preventDefault();
                            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
                            const sel = view.state.selection.main;
                            if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) {
                                view.dispatch({ selection: { anchor: pos } });
                            }
                            openContextMenu({
                                x: e.clientX,
                                y: e.clientY,
                                label: 'Note actions',
                                opener: document.activeElement as HTMLElement | null,
                                entries: editorMenuEntries(view, onNotify),
                            });
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={async (e) => {
                            e.preventDefault();
                            const item = e.dataTransfer.items?.[0];
                            if (!item || item.kind !== 'file') return;
                            // Before any await: the items are unreadable once
                            // this handler returns.
                            const dropped = item.getAsFile();
                            if (!dropped || !dropped.name.endsWith('.md')) return;
                            const view = viewRef.current;
                            if (!view) return;
                            const slot = e.currentTarget.closest('.editor-slot');
                            const keyboard = document.activeElement;
                            if (keyboard instanceof HTMLElement && keyboard !== document.body && !slot?.contains(keyboard)) {
                                keyboard.blur();
                            }
                            takeFocus();
                            if (!canWrite(view.state)) {
                                onNotify(file.isHelp
                                    ? `“${dropped.name}” did not replace the Help Guide, which cannot be edited.`
                                    : `“${dropped.name}” did not replace “${file.name}”, which is open for reading. ${READ_MODE_REASON}, then drop the file again.`);
                                return;
                            }
                            const text = await dropped.text();
                            const now = viewRef.current;
                            if (!now || !canWrite(now.state)) return;
                            now.dispatch({ changes: { from: 0, to: now.state.doc.length, insert: text } });
                        }}
                    />
                )}
            </div>
        </div>
    );
}

export default React.memo(DocumentPane);
