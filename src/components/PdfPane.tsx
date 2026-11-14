import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFileSystem } from '../context/FileSystemContext';
import { readPdfRole } from '../utils/pdfAnnotation';
import { createPdfDocumentSession } from '../utils/pdfDocumentSession';
import type { PdfDocumentSession } from '../utils/pdfDocumentSession';
import { createPdfTextReader, pdfTextAnchor, USER_TEXT_NAVIGATION_CAUSES } from '../utils/pdfReadingText';
import type { PdfTextAnchor, PdfTextReader, PdfTextTypography } from '../utils/pdfReadingText';
import { readPdfNavigationRevision, readPdfViewPos, writePdfViewPos } from '../utils/pdfViewState';
import type { PdfViewPos } from '../utils/pdfViewState';
import PdfReadingText from './PdfReadingText';
import { canRebuildAnnotatedPdf, isEditablePdfRole, pdfRoleNotice, revokePdfRole, revokePdfSource } from '../utils/pdfRole';
import { getPdfRenderData } from '../utils/pdfRenderCache';
import type { PdfAnnotationPreflight, PdfRole } from '../utils/pdfRole';
import PdfViewer from './PdfViewer';
import type { PdfViewerHandle } from './PdfViewer';
import { peekPdfFindMemory, retainPdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import DiskBar from './DiskBar';
import { useActivated, useFloatingSlot } from './floatingSlot';
import type { ActiveFile, ContentChangeOptions, DiskAction, EditorMode, PdfRebuildNotice } from '../types';
import type { LocationCause, PdfReadingBinding, ReaderCapabilities, ReaderIdentity } from '../types/reading';
import type { DiskVersion } from '../utils/diskVersion';
import { registerReadingSurface } from '../utils/documentReading';
import { flushPdfTextViewState } from '../utils/readerViewState';
import { pdfNativeEmphasisAvailability } from '../utils/pdfNativeEmphasis';
import type { PdfNativeEmphasisResult } from '../utils/pdfNativeEmphasis';
import type { EmphasisAvailability } from '../types/reading';

// tldraw + pdf.js rasterization are heavy and only needed once someone actually
// annotates, so the canvas is a separate chunk. Viewing a PDF never loads it.
const PdfAnnotateCanvas = lazy(() => import('./PdfAnnotateCanvas'));

export interface PdfPaneProps {
    reading?: PdfReadingBinding;
    file: ActiveFile;
    /**
     * Whether this document is on screen. EditorPane keeps one pane MOUNTED per
     * open PDF tab and merely hides the ones that aren't, so switching tabs
     * never reloads the document or loses the reading position. Hidden panes
     * hold their viewer; only the annotate canvas is torn down (it's a whole
     * tldraw instance, and unmounting it is also what flushes strokes).
     */
    isVisible: boolean;
    /**
     * Whether this is the FOCUSED pane, which is a narrower thing than being on
     * screen once tabs can hold several documents: two PDFs may be visible side
     * by side, but the +/- zoom keys belong to exactly one of them.
     */
    isFocused: boolean;
    /** Which COLUMN this document occupies, and that column's left edge and
     *  width as percentages of the editor. The pane is positioned over the
     *  column — it can't be a child of it, since it has to outlive it (see
     *  isVisible) — and both forms are needed: the index addresses the editor's
     *  live CSS variables while the pane is on screen, the numbers are what it
     *  freezes to once it isn't (see slotStyle). */
    slotIndex: number;
    slotLeft: number;
    slotWidth: number;
    /** Make this the focused pane. The pane floats OVER its slot rather than
     *  sitting inside it, so DocumentPane's own mousedown/focus handlers can
     *  never see a click that lands on the document — without this, clicking a
     *  PDF in a split left ⌘E, ⌘S, the top-bar actions and the +/− zoom keys
     *  acting on whichever neighbour was focused before. */
    onFocusPane: (path: string) => void;
    /** 'read' = view the real PDF, 'edit' = annotate. Reuses the per-tab mode. */
    mode: EditorMode;
    /** The tab's buffered tldraw snapshot (annotated files only). */
    content: string;
    onContentChange: (path: string, content: string, options?: ContentChangeOptions) => void;
    /** Writes to disk immediately; used as the canvas hands over to the viewer. */
    onFlushNow: (path: string, content: string) => void;
    /** This PDF is a notebook's export — open that notebook instead. Takes the
     *  PDF's own path too, so App can put its tab back into reading mode. */
    onOpenNotebookSource: (pdfPath: string, notebookPath: string) => void;
    /** Turn the pages a quarter and write the file (App.rotatePdf). Reading
     *  only: the annotate canvas draws against the pages as they are. */
    onRotate: (path: string, delta: number, pageIndex?: number) => void;
    /** True while this tab has strokes not yet written to disk. */
    isDirty: boolean;
    /** The file parted ways with the tab on disk (OpenTab.disk). The bar is
     *  drawn HERE, not by DocumentPane: this pane floats over the slot and
     *  would paint over one placed there. */
    disk?: 'conflict' | 'deleted';
    onDiskAction: (path: string, action: DiskAction) => Promise<void>;
    /** App owns the baseline and held choice, bound to the FULL reader token.
     *  When supplied, this callback also owns initial-edit baseline adoption. */
    onAnnotationPreflight?: (identity: ReaderIdentity, value: PdfAnnotationPreflight) => void;
    pdfRebuild?: PdfRebuildNotice;
    /** Only after App has kept that exact outer generation in Trash. The exact
     *  role's rebuild capability must also have been explicitly granted. */
    pdfRebuildApproval?: { generation: string };
}

interface PdfSource {
    entry: object;
    role: PdfRole;
    handle: FileSystemFileHandle;
    path: string;
}

/**
 * A PDF in the vault, in one of two modes.
 *
 * View mode is a pdf.js-rendered scroll of pages (PdfViewer) with a selectable
 * text layer. It replaced the browser's viewer in an <iframe> because that
 * viewer is a closed box: it cannot report the current page, which made both
 * "reopen where I left off" and keeping the position across tab switches
 * impossible.
 *
 * Annotate mode is a tldraw canvas over rasterized pages. The two are separate
 * modes rather than one blended view because a rasterized page has no text to
 * select — the pixels are all that's left. See utils/pdfAnnotation.ts.
 */
const DEFAULT_TEXT_TYPOGRAPHY: PdfTextTypography = { family: 'serif', size: 18, leading: 1.6, measure: 'comfortable', margins: 'medium', theme: 'follow-app' };

function PdfPane({ reading, file, isVisible, isFocused, slotIndex, slotLeft, slotWidth, onFocusPane, mode, content, onContentChange, onFlushNow, onOpenNotebookSource, onRotate, isDirty, disk, onDiskAction, onAnnotationPreflight, pdfRebuildApproval, pdfRebuild }: PdfPaneProps) {
    const { readBytesVersioned } = useFileSystem();
    const root = useRef<HTMLDivElement>(null), viewerActions = useRef<PdfViewerHandle>(null);
    const findVault = reading?.identity.vaultId, findEpoch = reading?.identity.vaultEpoch, findDocument = reading?.identity.documentId;
    const findIdentity = useMemo(() => findVault !== undefined && findEpoch !== undefined && findDocument !== undefined
        ? { vaultId: findVault, vaultEpoch: findEpoch, documentId: findDocument } : undefined, [findVault, findEpoch, findDocument]);
    const findMemory = useMemo<PdfFindMemory>(() => findIdentity ? peekPdfFindMemory(findIdentity) ?? { open: false, query: '' } : { open: false, query: '' }, [findIdentity]);
    useLayoutEffect(() => findIdentity ? retainPdfFindMemory(findIdentity, findMemory) : undefined, [findIdentity, findMemory]);
    // Binding values change on preference/status updates. A retained session and
    // its async consumers always call the current binding without reopening bytes.
    const binding = useRef(reading);
    const writeState = useRef({ isDirty, disk, onAnnotationPreflight });
    useLayoutEffect(() => { binding.current = reading; writeState.current = { isDirty, disk, onAnnotationPreflight }; });
    const displayedVersion = useRef<DiskVersion | undefined>(undefined);
    const pageDigest = useRef<string | undefined>(undefined);
    const restoredRecord = useRef(false);
    const [roleRetry, setRoleRetry] = useState(0);
    const readerIdentity = reading?.identity;
    const annotateEntry = useMemo(() => ({ mode, handle: file.handle, path: file.path, attempt: roleRetry, readerIdentity }), [mode, file.handle, file.path, roleRetry, readerIdentity]);
    const currentEntry = useRef(annotateEntry);
    useLayoutEffect(() => { currentEntry.current = annotateEntry; }, [annotateEntry]);
    const [loadedSource, setSource] = useState<PdfSource | null>(null);
    // Render-time entry identity is necessary: effect cleanup alone leaves one
    // commit in which a prior vault/path/mode's role could mount a canvas before
    // the new preflight. Each return to Annotate starts without a capability.
    const source = loadedSource && loadedSource.entry === annotateEntry && loadedSource.handle === file.handle && loadedSource.path === file.path ? loadedSource.role : null;
    const foreignHeld = source?.kind === 'annotated' && source.writeMark.kind === 'foreign' &&
        (!source.generation || pdfRebuildApproval?.generation !== source.generation || !canRebuildAnnotatedPdf(source.original));
    const editableSource = source && isEditablePdfRole(source) && !foreignHeld && canRebuildAnnotatedPdf(source.original) ? source : null;
    // The outer pages remain readable on refusal. DiskBar owns the choice;
    // don't put a competing action over the page.
    const foreignNotice = !foreignHeld ? undefined : source.writeMark.kind === 'foreign' && source.writeMark.reason === 'mismatch'
        ? 'This PDF was changed by another program after this app saved it. Annotate is read-only so rebuilding its pages does not discard those changes. You can still read the PDF.'
        : 'The PDF write mark cannot be verified by this version. Annotate is read-only so rebuilding its pages does not discard changes. You can still read the PDF.';
    const roleNotice = source && pdfRoleNotice(source) || (!disk && !pdfRebuild ? foreignNotice : undefined);
    const readOnly = mode === 'edit' && (!!roleNotice || foreignHeld || !!disk || source !== null && !editableSource && isEditablePdfRole(source));
    const [session, setSession] = useState<PdfDocumentSession | null>(null);
    const generation = useRef(0);
    const returnEpoch = useRef(0);
    useEffect(() => () => { ++returnEpoch.current; flushPdfTextViewState(); }, []);
    const [textReader, setTextReader] = useState<PdfTextReader | null>(null);
    useLayoutEffect(() => { textReader?.setVisible(isVisible); }, [textReader, isVisible]);
    const [textSurface, setTextSurface] = useState(false);
    const lastReturnRevision = useRef<number | undefined>(undefined);
    const textAnchor = useRef<PdfTextAnchor | undefined>(undefined);
    const [initialTextAnchor, setInitialTextAnchor] = useState<PdfTextAnchor>();
    const originalCheckpoint = useRef<(PdfViewPos & { navigationRevision: number }) | undefined>(undefined);
    const textNavigationRevision = useRef(0);
    const textCheckpointRevision = useRef(0);
    const savedAtMount = reading?.initialRecord;
    const protectedRestore = useRef<{ textRevision: number; originalRevision: number } | undefined>(
        savedAtMount && (!savedAtMount.anchorUsable || savedAtMount.storedV !== 1 || savedAtMount.storedSchema !== 1)
            ? { textRevision: 0, originalRevision: readPdfNavigationRevision(file.path) } : undefined);
    const [sameTextSchema, setSameTextSchema] = useState(true);
    const [restoreNotice, setRestoreNotice] = useState('');
    const textPage = useRef(0);
    const [mappingNotice, setMappingNotice] = useState('');
    const [nativeReader, setNativeReader] = useState<EmphasisAvailability>(() => pdfNativeEmphasisAvailability());
    const [nativeAnnotation, setNativeAnnotation] = useState<EmphasisAvailability>(() => pdfNativeEmphasisAvailability());
    // A remounted renderer may start on a different physical page. Retain the
    // preference, but never borrow the previous surface's glyph eligibility.
    useLayoutEffect(() => { setNativeReader(pdfNativeEmphasisAvailability()); }, [session, mode, textSurface]);
    useLayoutEffect(() => { setNativeAnnotation(pdfNativeEmphasisAvailability()); }, [source, mode, isVisible]);
    const reportNative = (setter: typeof setNativeReader, result?: PdfNativeEmphasisResult) => {
        const next = pdfNativeEmphasisAvailability(result);
        setter(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const [textQuality, setTextQuality] = useState<'available' | 'partial' | 'none'>('partial');
    const textSurfaceRef = useRef(false);
    function publishLocation(cause: LocationCause, surface = textSurfaceRef.current) {
        const b = binding.current, version = displayedVersion.current;
        if (!b || !version) return;
        const held = protectedRestore.current;
        // A rollback must still find the other engine's original record. Only
        // the app's navigation counters release it, never a layout/cleanup cause.
        if (held) {
            if (textNavigationRevision.current <= held.textRevision && readPdfNavigationRevision(file.path) <= held.originalRevision) return;
            protectedRestore.current = undefined;
        }
        const pos = surface ? originalCheckpoint.current : readPdfViewPos(file.path);
        b.onReaderLocation(b.identity, { kind: 'pdf-text', value: {
            v: 1, surface: surface ? 'text' : 'original', rawFingerprint: version.hash, extractionSchema: 1,
            pageDigest: pageDigest.current, textAnchor: textAnchor.current,
            originalCheckpoint: { page: pos?.page ?? 0, offset: pos?.offset ?? 0, zoom: pos?.zoom ?? 1,
                navigationRevision: surface ? originalCheckpoint.current?.navigationRevision ?? 0 : readPdfNavigationRevision(file.path) },
            textNavigationRevision: textNavigationRevision.current,
        } }, cause);
    }
    useEffect(() => () => { if (session) void session.dispose().catch(console.error); }, [session]);
    useEffect(() => {
        if (!session) return;
        const b = binding.current;
        const controller = createPdfTextReader(session, b?.identity, {
            initialPageIndex: readPdfViewPos(file.path)?.page ?? 0,
            onStatus: status => {
                const latest = binding.current;
                if (textSurfaceRef.current) latest?.onReaderStatus(latest.identity, status);
            },
        });
        setTextReader(controller);
        const epoch = returnEpoch;
        return () => { ++epoch.current; controller.dispose(); setTextReader(null); };
    }, [session, file.path]);
    async function showText() {
        if (mode !== 'read' || isDirty || flushing || disk || !textReader || !session) throw new Error('Wait for PDF annotations to finish saving before opening extracted text.');
        if (textSurfaceRef.current) { focusReading(); return; }
        const epoch = ++returnEpoch.current;
        setMappingNotice('');
        setSameTextSchema(true); setRestoreNotice(''); pageDigest.current = undefined;
        const checkpoint = readPdfViewPos(file.path) ?? { page: 0, offset: 0, zoom: 1 };
        const revision = readPdfNavigationRevision(file.path);
        originalCheckpoint.current = { ...checkpoint, navigationRevision: revision };
        textCheckpointRevision.current = textNavigationRevision.current;
        textPage.current = checkpoint.page;
        let next: PdfTextAnchor = { physicalPageIndex: checkpoint.page, offsetUTF16: 0, affinity: 'after', quote: '', before: '', after: '' };
        if (textAnchor.current?.physicalPageIndex === checkpoint.page && lastReturnRevision.current === revision) next = textAnchor.current;
        else if (textReader) {
            try {
                const page = await textReader.getPage(checkpoint.page);
                const [, b, , d, , f] = page.geometry.viewportTransform;
                let nearest = Infinity, offset = 0;
                for (const item of page.intervals) {
                    if (item.syntheticLF || item.role === 'ambiguous') continue;
                    const y = b * item.transform[4] + d * item.transform[5] + f;
                    const distance = Math.abs(y - checkpoint.offset * page.geometry.height);
                    if (distance < nearest) { nearest = distance; offset = item.from; }
                }
                next = pdfTextAnchor(page, offset);
            } catch { /* The Text surface owns its actionable page error/retry. */ }
        }
        if (returnEpoch.current !== epoch) return;
        if (readPdfNavigationRevision(file.path) !== revision) return;
        textAnchor.current = next;
        setInitialTextAnchor(next);
        textSurfaceRef.current = true;
        setTextSurface(true);
        publishLocation('user-navigation', true);
    }

    async function showOriginal(pageIndex?: number) {
        const epoch = ++returnEpoch.current;
        if (!textSurfaceRef.current) { focusReading(); return; }
        const checkpoint = originalCheckpoint.current ?? { page: 0, offset: 0, zoom: 1 };
        let target = checkpoint;
        if (pageIndex !== undefined || textNavigationRevision.current > textCheckpointRevision.current) {
            const page = pageIndex ?? textPage.current;
            target = { ...checkpoint, page, offset: 0 };
            const anchor = textAnchor.current;
            if (textReader && anchor?.physicalPageIndex === page) {
                try {
                    const model = await textReader.getPage(page);
                    if (returnEpoch.current !== epoch) return;
                    const item = model.intervals.find(i => !i.syntheticLF && i.from <= anchor.offsetUTF16 && i.to > anchor.offsetUTF16);
                    if (item && item.transform.length >= 6 && item.role !== 'ambiguous') {
                        const [, b, , d, , f] = model.geometry.viewportTransform;
                        const x = item.transform[4], y = item.transform[5];
                        const top = b * x + d * y + f;
                        target.offset = Math.max(0, Math.min(1, top / model.geometry.height));
                        setMappingNotice('Returned near the extracted word. PDF glyph geometry is approximate.');
                    } else setMappingNotice('Returned to the physical page; precise word geometry was unavailable.');
                } catch { if (returnEpoch.current !== epoch) return; setMappingNotice('Returned to the physical page; precise word geometry was unavailable.'); }
            } else setMappingNotice('Returned to the physical page.');
        }
        if (returnEpoch.current !== epoch) return;
        writePdfViewPos(file.path, target);
        lastReturnRevision.current = readPdfNavigationRevision(file.path);
        textSurfaceRef.current = false;
        setTextSurface(false);
        publishLocation('user-navigation', false);
    }
    // A failed attachment read is a tagged read-only role, not a failure to
    // display the outer pages. Keep the viewer's own IO error separate.
    const [viewError, setViewError] = useState<string | null>(null);
    const error = mode === 'read' || readOnly ? viewError : null;

    // Panes for background tabs mount hidden at session restore; don't touch
    // the disk (or pdf.js) until the tab is first brought to the front.
    const activated = useActivated(isVisible);

    // Standing this pane over its column, and what it freezes to once hidden:
    // components/floatingSlot.ts, which the canvas float shares.
    const slotStyle = useFloatingSlot(isVisible, slotIndex, slotLeft, slotWidth);

    // True from the moment the canvas starts exporting until that save lands.
    // `isDirty` alone can't cover this: the export takes a moment, and the tab
    // isn't marked dirty until it finishes — a window in which the viewer would
    // happily read and show the pre-annotation file.
    const [flushing, setFlushing] = useState(false);
    // The save landing is what pulls `dirty` back down — this file's own write,
    // not some other tab's (the old global saveEpoch signal reloaded the view,
    // and with it the scroll position, whenever ANY file autosaved).
    useEffect(() => { if (!isDirty) setFlushing(false); }, [isDirty]);

    // Safety net: `flushing` normally clears when this file's save lands, but a
    // save that THROWS leaves `dirty` set — which would leave "Applying
    // annotations…" covering the document for the rest of the session. Failing
    // back to showing the file (stale though it may be) beats hiding it forever.
    useEffect(() => {
        if (!flushing) return;
        const timer = setTimeout(() => {
            console.warn('PDF save did not complete in time; showing the file as it stands on disk.');
            setFlushing(false);
        }, 15000);
        return () => clearTimeout(timer);
    }, [flushing]);

    // Set when a write happened since the view was last read → it's stale and
    // the next chance to re-read should take it (and only then; re-reading on
    // every mode toggle would reload a document that hasn't changed).
    const viewStaleRef = useRef(false);
    useEffect(() => { if (isDirty) viewStaleRef.current = true; }, [isDirty]);

    /* Read the file's role only once annotating is actually wanted.
       Every PDF can be annotated now, so this can no longer be gated on the
       filename — and reading every PDF on open just to find out would be an
       N-MB allocation and a disk read for documents opened to read. Sticky: it
       stays true after the first switch, so toggling back to reading does not
       throw away the original the canvas is drawing on. */
    const [needsSource, setNeedsSource] = useState(mode === 'edit');
    useEffect(() => { if (mode === 'edit') { ++returnEpoch.current; restoredRecord.current = true; setNeedsSource(true); textSurfaceRef.current = false; setTextSurface(false); } }, [mode]);

    // Load once per file (once activated and wanted). A file already annotated
    // here yields its pristine original and existing snapshot out of its
    // attachments; any other PDF yields itself as the original.
    //
    // Recheck on each Annotate entry, but never mid-stroke/on autosave: replacing
    // the source underneath a live canvas would re-rasterize every page.
    useEffect(() => {
        if (!activated || !needsSource || mode !== 'edit') return;
        let cancelled = false;
        const isCurrent = () => !cancelled && currentEntry.current === annotateEntry;
        let inspected: PdfRole | undefined;
        if (loadedSource) revokePdfRole(loadedSource.role);
        // Graph/disk remounts lose component state, not the parked save data.
        // A fresh preflight revokes that older source too, before any await.
        const parked = getPdfRenderData(file.path);
        if (parked) revokePdfSource(parked.original);
        setSource(null);

        (async () => {
            try {
                if (!file.handle) return;

                // Every PDF is annotatable now, in the file you opened — so the
                // role is read by CONTENT for all of them, not just for files
                // whose name says "(annotated)". Still only when annotating: a
                // PDF opened to read is a wasted N-MB allocation and disk read
                // otherwise, and the viewer does its own read below.
                const handle = file.handle as FileSystemFileHandle;
                const { bytes, version } = await readBytesVersioned(handle);
                if (!isCurrent()) return;
                const role = inspected = await readPdfRole(bytes, version.hash);
                if (!isCurrent()) { revokePdfRole(role); return; }
                // An external program can replace bytes while the worker is
                // decoding an attachment. A fresh generation, not the earlier
                // stat or observer hint, decides which source may be mounted.
                const current = await readBytesVersioned(handle);
                if (!isCurrent() || current.version.hash !== version.hash) {
                    revokePdfRole(role);
                    if (isCurrent()) {
                        viewStaleRef.current = true;
                        setSession(null);
                        setRoleRetry(value => value + 1);
                    }
                    return;
                }
                // An agent/graph restore can start directly in edit mode, with
                // no prior viewer read to seed App's versioned-write baseline.
                const b = binding.current;
                // Like the viewer, a role read must not silently adopt disk's
                // baseline over an unsaved local revision or a held conflict.
                if (b && isEditablePdfRole(role) && writeState.current.onAnnotationPreflight) {
                    writeState.current.onAnnotationPreflight(b.identity, { role, version: current.version });
                } else if (!writeState.current.isDirty && !writeState.current.disk) {
                    if (displayedVersion.current && displayedVersion.current.hash !== current.version.hash) {
                        viewStaleRef.current = true;
                        setSession(null);
                    }
                    b?.onReaderVersion(b.identity, current.version);
                }
                if (binding.current?.initialRecord?.record.rawFingerprint !== current.version.hash) protectedRestore.current = undefined;
                displayedVersion.current = current.version;
                setSource({ role, handle, path: file.path, entry: annotateEntry });
            } catch (err) {
                if (inspected) revokePdfRole(inspected);
                console.error('Could not open PDF:', err);
                if (isCurrent()) setSource({ role: { kind: 'unreadable', alreadyAnnotated: true, generation: '', attachment: 'PDF', reason: 'corrupt' }, handle: file.handle as FileSystemFileHandle, path: file.path, entry: annotateEntry });
            }
        })();

        return () => { cancelled = true; };
    // loadedSource is the result, not an input: adding it would inspect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activated, needsSource, mode, file.path, file.handle, file.name, readBytesVersioned, roleRetry, annotateEntry]);

    // Read the bytes the viewer shows: once on first need, and again only after
    // a save of THIS file lands (mid-flush the bytes on disk still predate the
    // strokes, so wait out `flushing`/`isDirty`; their clearing re-runs this).
    useEffect(() => {
        if (!activated || mode !== 'read' && !readOnly || !file.handle || flushing || isDirty) return;
        if (session && !viewStaleRef.current) return;
        let cancelled = false;

        (async () => {
            try {
                const { bytes, version } = await readBytesVersioned(file.handle as FileSystemFileHandle);
                if (cancelled) return;
                const b = binding.current;
                if (b?.initialRecord?.record.rawFingerprint !== version.hash) protectedRestore.current = undefined;
                displayedVersion.current = version;
                // A read-only foreign view must not move the write baseline
                // after App captured it for the keep-copy choice.
                if (!writeState.current.isDirty && !writeState.current.disk) b?.onReaderVersion(b.identity, version);
                if (!restoredRecord.current) {
                    restoredRecord.current = true;
                    const saved = b?.initialRecord, record = saved?.record;
                    if (saved && record?.rawFingerprint === version.hash) {
                        const sameSchema = saved.anchorUsable && saved.storedSchema === 1 && saved.storedV === 1;
                        originalCheckpoint.current = record.originalCheckpoint;
                        textNavigationRevision.current = record.textNavigationRevision;
                        textCheckpointRevision.current = record.textNavigationRevision;
                        protectedRestore.current = sameSchema ? undefined : {
                            textRevision: textNavigationRevision.current, originalRevision: readPdfNavigationRevision(file.path),
                        };
                        setSameTextSchema(sameSchema);
                        const notice = saved.anchorUsable ? '' : 'Restored to the page; the saved text position was made by a newer version of the app.';
                        setRestoreNotice(notice); setMappingNotice(notice);
                        const anchor = record.textAnchor ?? { physicalPageIndex: record.originalCheckpoint.page,
                            offsetUTF16: 0, affinity: 'after' as const, quote: '', before: '', after: '' };
                        textAnchor.current = anchor;
                        textPage.current = anchor.physicalPageIndex;
                        pageDigest.current = sameSchema ? record.pageDigest : undefined;
                        writePdfViewPos(file.path, record.originalCheckpoint);
                        if (record.surface === 'text') {
                            textSurfaceRef.current = true;
                            setInitialTextAnchor(anchor);
                            setTextSurface(true);
                        }
                    }
                }
                viewStaleRef.current = false;
                setViewError(null);   // a later read succeeded — clear ITS stale failure
                setSession(createPdfDocumentSession(bytes, ++generation.current));
            } catch (err) {
                // Surfaced, not just logged: this is now the ONLY read a plain
                // PDF does (the attachment read above is skipped for it), so a
                // file that has gone away underneath us would otherwise leave
                // the pane on "Loading PDF…" for the rest of the session.
                console.error('Could not refresh the PDF view:', err);
                if (!cancelled) setViewError(err instanceof Error ? err.message : String(err));
            }
        })();

        return () => { cancelled = true; };
    }, [activated, mode, readOnly, flushing, isDirty, session, file.handle, file.path, readBytesVersioned]);

    function focusReading() {
        root.current?.querySelector<HTMLElement>(mode === 'edit' && !readOnly ? '.tl-container' : textSurfaceRef.current ? '.pdf-reading-scroll' : '.pdf-viewer-scroll')?.focus({ preventScroll: true });
    }
    const capabilities: ReaderCapabilities = {
        surface: mode === 'edit' && !readOnly ? 'pdf-annotation' : textSurface ? 'pdf-text' : 'pdf-original',
        emphasis: disk ? { kind: 'inactive', reason: 'Resolve the PDF disk change to refresh Word emphasis' }
            : mode === 'edit' && !readOnly ? nativeAnnotation
            : isDirty || flushing || !session ? { kind: 'inactive', reason: 'Waiting for the PDF to finish loading or saving' }
            : textSurface ? { kind: 'inactive', reason: 'Word emphasis applies to Original PDF pages. Choose Original PDF to use it.' }
            : nativeReader,
        text: textSurface ? textQuality : 'partial', find: mode === 'read' || readOnly, copy: mode === 'read' || readOnly, appearance: textSurface ? 'reflow' : 'none',
    };
    function findReading() {
        if (mode !== 'read' && !readOnly) return;
        if (textSurfaceRef.current) { const input = root.current?.querySelector<HTMLInputElement>('.pdf-reading-find input'); input?.focus(); input?.select(); }
        else { findMemory.open = true; viewerActions.current?.openFind(); }
    }
    const actions = useRef({ showText, showOriginal, focusReading, findReading, capabilities, publishLocation });
    useLayoutEffect(() => { actions.current = { showText, showOriginal, focusReading, findReading, capabilities, publishLocation }; });
    const identity = reading?.identity;
    const registerKeyboardTarget = reading?.registerKeyboardTarget;
    useEffect(() => {
        if (!identity) return;
        const unregister = registerReadingSurface(identity, {
            capabilities: () => actions.current.capabilities,
            showPdfText: () => actions.current.showText(),
            showPdfOriginal: () => actions.current.showOriginal(),
            findReading: () => actions.current.findReading(),
            focusReading: () => actions.current.focusReading(),
        });
        const unregisterKeyboard = registerKeyboardTarget?.(file.path, () => actions.current.focusReading());
        return () => { actions.current.publishLocation('layout'); flushPdfTextViewState(); unregisterKeyboard?.(); unregister(); };
    }, [identity, file.path, registerKeyboardTarget]);
    const capabilityKey = JSON.stringify(capabilities);
    useEffect(() => {
        const b = binding.current;
        b?.onReaderCapabilities(b.identity, actions.current.capabilities);
        b?.onReaderStatus(b.identity, error ? { phase: 'error', message: error } : { phase: session || mode === 'edit' && source ? 'ready' : 'loading' });
    }, [capabilityKey, error, session, mode, source]);
    useEffect(() => {
        if (!isVisible) { actions.current.publishLocation('layout'); flushPdfTextViewState(); }
    }, [isVisible]);

    // Bound to this pane's path once: a fresh arrow per render would re-render
    // the memoized viewer on every keystroke anywhere in the app.
    const rotateThis = useCallback(
        (delta: number, pageIndex?: number) => onRotate(file.path, delta, pageIndex),
        [onRotate, file.path]);

    let body: ReactNode = null;
    if (activated) {
        if (error) {
            body = <div className="pdf-pane-message">Could not open this PDF: {error}</div>;
        } else if (mode === 'edit' && !source) {
            /* Waiting on the ROLE read, which is lazy — only annotating needs
               it. Gating every branch on it (as this did) left a PDF opened for
               reading stuck on "Loading PDF…" forever, waiting for a read that
               no longer happens until you switch to annotate. Reading needs
               `viewBytes` and nothing else; that is the branch further down. */
            body = <div className="pdf-pane-message">Loading PDF…</div>;
        } else if (mode === 'edit' && source?.kind === 'notebookExport') {
            // A notebook's export. Annotating it would fork a third document
            // whose marks the notebook could neither see nor replace, so the
            // pane hands you back to the notebook instead of drawing anything.
            body = (
                <div className="pdf-pane-message">
                    This PDF was exported from <strong>{source.notebookSource.path}</strong>.
                    <button
                        className="pdf-pane-action"
                        onClick={() => onOpenNotebookSource(file.path, source.notebookSource.path)}
                    >
                        Open the notebook
                    </button>
                </div>
            );
        } else if (mode === 'edit' && editableSource) {
            // The annotate canvas only exists while its document is on screen:
            // a hidden tldraw instance would pin megabytes of page bitmaps, and
            // unmounting it is what flushes pending strokes to disk.
            body = isVisible ? (
                <Suspense fallback={<div className="pdf-pane-message">Loading annotation tools…</div>}>
                    <PdfAnnotateCanvas
                        key={file.path}
                        filePath={file.path}
                        original={editableSource.original}
                        emphasisEnabled={reading?.emphasisEnabled ?? false}
                        onNativeEmphasisResult={(_page, result) => reportNative(setNativeAnnotation, result)}
                        // Only an unsaved buffer outranks this fresh role read.
                        // A clean old snapshot must not hide another app's ink.
                        snapshot={isDirty ? content || editableSource.snapshot : editableSource.snapshot}
                        onContentChange={onContentChange}
                        onFlushNow={onFlushNow}
                        onFlushStart={() => setFlushing(true)}
                    />
                </Suspense>
            ) : null;
        } else if (isDirty || flushing) {
            // Between leaving the canvas and the write landing (a few hundred ms)
            // the file on disk still predates the last strokes. Say so rather than
            // render a PDF that's missing the annotations the user just drew.
            body = <div className="pdf-pane-message">Applying annotations…</div>;
        } else if (!session) {
            body = <div className="pdf-pane-message">Loading PDF…</div>;
        } else {
            body = textSurface && textReader ? (
                <PdfReadingText filePath={file.path} controller={textReader} isFocused={isFocused} isVisible={isVisible} anchor={initialTextAnchor} expectedPageDigest={pageDigest.current}
                    sameSchema={sameTextSchema} restorationNotice={restoreNotice}
                    onShowOriginalPage={page => { void showOriginal(page); }} onShowOriginal={() => { void showOriginal(); }}
                    onLocation={(anchor, cause, digest) => {
                        textAnchor.current = anchor;
                        pageDigest.current = digest;
                        textPage.current = anchor.physicalPageIndex;
                        if (USER_TEXT_NAVIGATION_CAUSES.some(userCause => userCause === cause)) ++textNavigationRevision.current;
                        publishLocation(cause);
                    }} onTextQuality={setTextQuality} emphasisEnabled={false} typography={reading?.typography ?? DEFAULT_TEXT_TYPOGRAPHY}
                    onTypographyChange={reading?.onTypographyChange} />
            ) : textSurface ? <div className="pdf-pane-message">Opening extracted text…</div> : <><PdfViewer ref={viewerActions} filePath={file.path} session={session} reader={textReader ?? undefined} findMemory={findMemory} onNotify={reading?.onNotify} isActive={isFocused} isVisible={isVisible} onRotate={rotateThis}
                onLocation={() => publishLocation('layout', false)} emphasisEnabled={reading?.emphasisEnabled ?? false}
                onNativeEmphasisResult={(_page, result) => reportNative(setNativeReader, result)} />
                {mappingNotice && <div className="pdf-pane-mapping-notice" role="status">{mappingNotice}</div>}
                {readOnly && roleNotice && <div className="pdf-pane-mapping-notice pdf-role-notice" role="status"
                    // Mapping notices are click-through; this one owns Retry.
                    style={{ pointerEvents: 'auto' }}
                    onContextMenu={event => event.preventDefault()}
                    onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
                    {roleNotice}
                    <button className="pdf-pane-action" onClick={() => setRoleRetry(value => value + 1)}>Retry</button>
                </div>}
            </>;
        }
    }

    // One stable root for every state, so EditorPane can hide an off-screen pane
    // with CSS instead of unmounting it (which would forget the document).
    return (
        <div
            ref={root}
            className={`pdf-pane${isVisible ? '' : ' pdf-pane-hidden'}`}
            style={slotStyle}
            // The pane floats over its slot, so this is the ONLY thing that can
            // report a click on a PDF as "focus this pane" — capture, so a
            // scroll, a text selection or a click on the zoom pill all count.
            onPointerDownCapture={() => { if (isVisible) onFocusPane(file.path); }}
            // Tab can enter another pane's page/find field without a pointer.
            // Its header commands must then belong to that same document.
            onFocusCapture={() => { if (isVisible && !isFocused) onFocusPane(file.path); }}
            onKeyDown={event => {
                if (!event.defaultPrevented && event.key === 'Escape' && !disk && pdfRebuild?.state === 'foreign') {
                    event.preventDefault(); void onDiskAction(file.path, 'keep-pdf');
                }
            }}
        >
            {(disk || pdfRebuild) && <DiskBar name={file.name} state={disk ?? pdfRebuild!.state} pdfRebuild={disk ? undefined : pdfRebuild} path={file.path} onAction={onDiskAction} />}
            {/* Always wrapped, bar or no bar: toggling the wrapper would remount
                the viewer and lose the reading position. */}
            <div className="pdf-pane-body">{body}</div>
        </div>
    );
}

// Memoized: EditorPane re-renders on every keystroke anywhere in the app and
// maps over every open PDF tab, so without this each mounted pane re-ran on
// every character typed in an unrelated note. Its props only change when this
// tab's own mode/content/dirty state does.
export default React.memo(PdfPane);
