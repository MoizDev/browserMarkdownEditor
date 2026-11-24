import type React from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { sameStat, type DiskVersion } from '../utils/diskVersion';
import type { Ask, Notify, Tell } from './useAppDialogs';
import type { FlushTab, NativePolicy, SetDiskState, SetTabs } from './types';
import { getSessionIdentity } from '../utils/sessionIdentity';
import { parentVaultPath } from '../utils/paths';
import { pdfEngineAvailableInBuild } from '../utils/pdfEngineAvailability';
import { drain } from '../utils/unloadCoordinator';
import { getView } from '../utils/viewRegistry';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { recordFileWritten } from '../utils/fileTimes';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { clearPdfRenderData } from '../utils/pdfRenderCache';
import { reportVault } from '../utils/perfHooks';
import { settlePdfRotationWrite, type PdfRotationOutcome } from '../utils/pdfRotationStandIn';
import type { RotationRefusal } from '../pdf/writing/protocol';
import { ensurePdfSessionRoute, readPdfSessionRoute } from '../utils/pdfSessionRoute';
import { createCanvasSessionBridge } from '../utils/canvasSessionBridge';
import { bindRecoveryAdapter } from '../utils/recoveryAdapters';
import { hasHostedNativeOwner, RECOVERY_SESSION_BINDING } from './nativeOwners';
import type { UsePdfActionsDeps } from './usePdfActions';
import { loadChunk } from '../platform/chunkLoad';

/**
 * The PDF gestures that only ever run on a PDF the reader is looking at:
 * an unsigned copy, a print, turning pages. Loaded on the gesture
 * (usePdfActions), never at startup: the PDF/canvas split is bundle-size discipline.
 */
export interface PdfGestureDeps extends UsePdfActionsDeps {
  unsignedCopyInFlight: React.MutableRefObject<boolean>
}

export async function handleUnsignedPdfCopy(deps: Pick<PdfGestureDeps,
  'getVaultActivation' | 'readFileSnapshot' | 'writeDistinctCopy' | 'ask' | 'tell' | 'rootHandleRef' |
  'documentBuffers' | 'documentSessions' | 'diskStateRef' | 'setDiskState' | 'currentPdfOwner' |
  'unsignedCopyInFlight'
>, identity: ReaderIdentity, displayed: DiskVersion) {
  const {
    getVaultActivation, readFileSnapshot, writeDistinctCopy, ask, tell, rootHandleRef, documentBuffers,
    documentSessions, diskStateRef, setDiskState, currentPdfOwner, unsignedCopyInFlight,
  } = deps;
  if (unsignedCopyInFlight.current) return;
  const source = currentPdfOwner(identity), root = rootHandleRef.current;
  const session = source && getSessionIdentity(source.id), activation = getVaultActivation();
  if (!source?.file.handle || !source.file.parentHandle || !root || !session) throw new Error('The signed PDF is no longer open.');
  const { handle, parentHandle, name, path } = source.file;
  const current = () => {
    const tab = currentPdfOwner(identity);
    return rootHandleRef.current === root && getVaultActivation() === activation && getSessionIdentity(source.id) === session &&
      tab?.file.handle === handle && tab.file.parentHandle === parentHandle && !diskStateRef.current.has(source.id) &&
      !documentBuffers.isDirty(source.id) && !documentSessions.hasPendingEdits(source.id);
  };
  const check = () => { if (!current()) throw new DOMException('The signed PDF changed. Open it again before creating a copy.', 'AbortError'); };
  const signal = new AbortController().signal;
  let snapshot: import('../types/reading').ReadOnlyFileSnapshot | undefined;
  unsignedCopyInFlight.current = true;
  try {
    check();
    if (!pdfEngineAvailableInBuild()) throw new Error('The native PDF engine is unavailable in this build.');
    const confirmed = await ask({ title: 'Create an unsigned PDF copy?', confirmLabel: 'Create unsigned copy',
      body: 'The new copy will have no valid digital signatures. The signed original stays unchanged and is also kept as an attachment in the copy. Use the original, not the copy, to verify signatures.' });
    if (!confirmed) return;
    check();
    snapshot = await readFileSnapshot(handle as FileSystemFileHandle, signal);
    const version = await snapshot.fingerprint(signal);
    check();
    if (version.hash !== displayed.hash) { setDiskState(source.id, 'conflict'); throw new Error('The PDF changed on disk. Resolve that change before creating an unsigned copy.'); }
    const [{ prepareUnsignedPdfCopy }, { getSharedPdfPool }] = await Promise.all([
      loadChunk(() => import('../pdf/writing/unsignedCopyClient')), loadChunk(() => import('../pdf/session/startup')),
    ]);
    check();
    const prepared = await prepareUnsignedPdfCopy({ pool: getSharedPdfPool(), source: snapshot.blob.slice(0, snapshot.blob.size, 'application/pdf'),
      originalSha: version.hash, isCurrent: current, signal });
    check();
    if (prepared.kind !== 'unsigned-copy-only' || prepared.originalSha !== version.hash) throw new Error('The writer did not return a verified unsigned copy.');
    const fresh = await readFileSnapshot(handle as FileSystemFileHandle, signal);
    try {
      if ((await fresh.fingerprint(signal)).hash !== version.hash) {
        setDiskState(source.id, 'conflict'); throw new Error('The signed original changed while the copy was prepared. Nothing has been written.');
      }
    } finally { fresh.dispose(); }
    check();
    const copy = await writeDistinctCopy(parentHandle, parentVaultPath(path), name.replace(/\.pdf$/i, '') + ' (unsigned).pdf',
      new Blob([prepared.bytes], { type: 'application/pdf' }), current);
    if (current()) void tell({ title: 'Unsigned PDF copy created', confirmLabel: 'OK',
      body: `"${copy.name}" is in the same folder. The signed original is unchanged; its exact bytes are attached to the copy as "${prepared.attachmentName}".` });
  } finally { snapshot?.dispose(); unsignedCopyInFlight.current = false; }
}

export async function preparePdfPrint(deps: Pick<PdfGestureDeps,
  'readBytesVersioned' | 'rootHandleRef' | 'tabsRef' | 'activeTabPathRef' | 'documentBuffers' |
  'documentSessions' | 'flushingRef' | 'flushTab' | 'flushChainsRef' | 'diskStateRef' | 'setDiskState' |
  'pdfSeedForRef'
>, path: string) {
  const {
    readBytesVersioned, rootHandleRef, tabsRef, activeTabPathRef, documentBuffers, documentSessions,
    flushingRef, flushTab, flushChainsRef, diskStateRef, setDiskState, pdfSeedForRef,
  } = deps;
  const tab = tabsRef.current.find(t => t.file.path === path);
  const root = rootHandleRef.current;
  if (!tab || !root || tab.representation.loadedKind !== 'pdf' || !tab.file.handle) throw new Error('This PDF is no longer open.');
  const { id } = tab, generation = tab.representation.generation, handle = tab.file.handle;
  const current = () => {
    const now = tabsRef.current.find(t => t.id === id);
    return rootHandleRef.current === root && activeTabPathRef.current === path && now?.file.path === path &&
      now.file.handle === handle && now.representation.generation === generation && !diskStateRef.current.get(id);
  };
  if (!current()) throw new Error('Return to this PDF and resolve any disk conflict before printing.');
  // Native Annotate and classic canvases hold strokes the App cannot see until
  // they report them; push those into the save funnel before reading any bytes.
  try { await getView(path)?.flushPending?.(); }
  catch { throw new Error('The PDF annotations could not be saved. Keep the file open and retry before printing.'); }
  await drain(id);
  await flushChainsRef.current.get(id);
  if (!current()) throw new Error('The document changed while preparing to print.');
  const revision = documentBuffers.revisionForDocument(id)?.revision;
  // A native ink edit lives in the document session, not the buffer: the buffer can be clean while it is pending.
  const needsSave = tabsRef.current.find(t => t.id === id)?.dirty || documentBuffers.isDirty(id) || documentSessions.hasPendingEdits(id);
  if (needsSave) {
    const outcome = await flushTab(path, true);
    // 'skipped' with clean bytes is a finished save: the combined dirty flag also counts
    // background session work, which refused every print after an annotation save.
    if (outcome !== 'written' && (outcome !== 'skipped' || documentBuffers.isDirty(id))) throw new Error('The annotations could not be saved. Resolve the PDF notice before printing.');
  }
  if (!current() || documentBuffers.revisionForDocument(id)?.revision !== revision || getView(path)?.hasPendingEdits?.()
      || documentSessions.hasPendingEdits(id)) throw new Error('The document changed while preparing to print.');
  const baseline = getBaseline(id) ?? await pdfSeedForRef.current(id);
  let disk: Awaited<ReturnType<typeof readBytesVersioned>>;
  try { disk = await readBytesVersioned(handle as FileSystemFileHandle); }
  catch (error) {
    if (current() && error instanceof DOMException && error.name === 'NotFoundError') setDiskState(id, 'deleted');
    throw error;
  }
  if (current() && baseline && disk.version.hash !== baseline.hash) setDiskState(id, 'conflict');
  if (!current() || !baseline || disk.version.hash !== baseline.hash || getBaseline(id)?.hash !== baseline.hash ||
      documentBuffers.revisionForDocument(id)?.revision !== revision || getView(path)?.hasPendingEdits?.() || documentSessions.hasPendingEdits(id)) throw new Error('The saved PDF changed. Reload or resolve its disk conflict before printing.');
  const valid = () => current() && getBaseline(id)?.hash === disk.version.hash && documentBuffers.revisionForDocument(id)?.revision === revision &&
    !getView(path)?.hasPendingEdits?.() && !documentSessions.hasPendingEdits(id) && !flushingRef.current.has(id);
  const validate = async () => {
    if (!valid()) return false;
    try {
      const latest = await readBytesVersioned(handle as FileSystemFileHandle);
      if (valid() && latest.version.hash !== disk.version.hash) setDiskState(id, 'conflict');
      return valid() && latest.version.hash === disk.version.hash;
    } catch (error) {
      if (valid() && error instanceof DOMException && error.name === 'NotFoundError') setDiskState(id, 'deleted');
      return false;
    }
  };
  return { bytes: disk.bytes, valid, validate };
}

const LEFT_AS_IT_IS = 'The file has been left as it is.';
const ANNOTATED_REFUSAL = 'This PDF carries annotations made here, and they are drawn against the pages as they are. Rotating would move every mark, so it is left alone.';

/** Why a PDF's pages could not be turned, in the person's words: what the writer found, what that means for the
 * file, and what they can do. The raw reasons ("PDF ink is read-only: signed.") were shown as they were. */
function rotationRefusal(cause: RotationRefusal | undefined): string {
  switch (cause) {
    case 'signed': return `This PDF is signed, and turning its pages would break the signature. ${LEFT_AS_IT_IS} To rotate it, create an unsigned copy and rotate that.`;
    case 'encrypted': return `This PDF is encrypted, so its pages cannot be turned here. ${LEFT_AS_IT_IS}`;
    case 'annotated': return ANNOTATED_REFUSAL;
    case 'notebook-source': return 'This PDF was exported from a notebook. Turn the pages in the notebook and export it again.';
    case 'missing-attachment':
      return `The annotations saved inside this PDF are incomplete or damaged, and turning its pages could lose them. ${LEFT_AS_IT_IS}`;
    case 'unsupported-rotation': return `This PDF has a page at an angle that is not a quarter turn, so its pages were not turned. ${LEFT_AS_IT_IS}`;
    case 'unsafe-policy': case 'unsupported-format':
      return `This PDF has parts this app cannot rewrite with certainty (forms, permissions or an unusual structure), so its pages were not turned. ${LEFT_AS_IT_IS}`;
    default: return `This PDF could not be read well enough to turn its pages safely. ${LEFT_AS_IT_IS}`;
  }
}

/** The same for a failure that surfaced as an error. */
function rotationFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : '', message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError') return 'The PDF changed while its pages were being turned, so nothing was saved. Try again.';
  if (name === 'UnsupportedSecurity' || /encrypt/i.test(message)) return rotationRefusal('encrypted');
  if (/signed/i.test(message)) return rotationRefusal('signed');
  if (/failed verification/.test(message)) return `The turned PDF did not pass its check, so nothing was saved. ${LEFT_AS_IT_IS}`;
  if (name === 'InvalidPdf' || name === 'PageError') return rotationRefusal(undefined);
  return `Could not turn this PDF's pages (${message.replace(/[.\s]+$/, '')}). ${LEFT_AS_IT_IS}`;
}

type RotateDeps = Pick<PdfGestureDeps,
  'getVaultActivation' | 'readFileSnapshot' | 'notifyRef' | 'rootHandleRef' |
  'currentVaultIdRef' | 'readerEpochRef' | 'tabsRef' | 'documentBuffers' | 'documentSessions' | 'setTabs' |
  'nativePoliciesRef' | 'bytesGenerationsRef' | 'bumpBytesGeneration' | 'flushingRef' | 'flushChainsRef' |
  'writeFileVersionedRef' | 'diskStateRef' | 'setDiskState' | 'pdfSeedForRef'
>;

/** Turns pressed but not yet taken by a write, per document: quarter turns for every page, and per page. */
interface PendingTurns { all: number; pages: Map<number, number>; presses: number; run: Promise<void> }
const pendingTurns = new Map<string, PendingTurns>();

/**
 * Turn a PDF's pages a quarter at a time, and write it.
 *
 * A REAL EDIT, not a view filter. The angle goes into each page's `/Rotate`, so a sideways scan is fixed everywhere
 * at once: this reader, the annotate canvas, the thumbnails, the saved file and whatever else the person opens it
 * with. Every consumer here already honours `/Rotate` (PDFium applies it to the page's display transform), so there
 * is no second coordinate system for a view-only rotation to keep in step with — the whole reason it is written.
 *
 * THE PANE HAS ALREADY TURNED (utils/pdfRotationStandIn.ts): this writes the file behind that picture and reports
 * each press's outcome back to it, which keeps the picture until the turned file is drawn sharp, or rolls it back.
 *
 * PRESSES COALESCE. Each press adds its turn to the document's pending turns; one write, queued on the same per-tab
 * chain `flushTab` uses, takes everything pressed until it starts. Four quick presses are one or two writes ending at
 * the right angle — never four racing ones, and never a lost press: a press during a write waits for the next.
 *
 * It writes an incremental update (pdf/writing/rotationUpdate.ts) through `writeFileVersioned` against the tab's
 * disk baseline; a file changed or gone on disk raises the DiskBar and writes nothing. The pane adopts the new bytes
 * IN PLACE, as it does after any other save of this document: a new byte generation, never a `diskRev` remount.
 *
 * REFUSED on a PDF this app has annotated: its strokes are authored against the pages as they are, and the ink is
 * rebuilt from the untouched original on every save, which would quietly turn the pages back. The writer decides
 * (with the signed/encrypted/unknown-policy refusals) at the moment of the gesture, so opening a PDF costs nothing.
 */
export function rotatePdf(deps: RotateDeps, path: string, delta: number, pageIndex?: number): Promise<void> {
  const { tabsRef, flushChainsRef } = deps;
  const tab = tabsRef.current.find(t => t.file.path === path);
  if (!tab?.file.handle || !Number.isSafeInteger(delta / 90)) { if (tab) settlePdfRotationWrite(tab.id, { kind: 'failed' }, 1); return Promise.resolve(); }
  const { id } = tab, quarter = ((delta / 90) % 4 + 4) % 4;
  const queued = pendingTurns.get(id);
  if (queued) {
    // Not started yet: it will take this press with the others.
    if (pageIndex === undefined) queued.all += quarter; else queued.pages.set(pageIndex, (queued.pages.get(pageIndex) ?? 0) + quarter);
    queued.presses++;
    return queued.run;
  }
  const entry = { all: pageIndex === undefined ? quarter : 0, pages: new Map(pageIndex === undefined ? [] : [[pageIndex, quarter]]), presses: 1 } as PendingTurns;
  const chains = flushChainsRef.current;
  const chained = (chains.get(id) ?? Promise.resolve()).then(async () => {
    // From here on, presses queue for the next write.
    if (pendingTurns.get(id) === entry) pendingTurns.delete(id);
    let outcome: PdfRotationOutcome = { kind: 'failed' };
    try { outcome = await writeTurns(deps, path, id, entry); }
    catch (err) { console.error('Could not rotate the PDF:', err); deps.notifyRef.current(rotationFailure(err)); }
    finally { settlePdfRotationWrite(id, outcome, entry.presses); }
  });
  entry.run = chained;
  pendingTurns.set(id, entry);
  chains.set(id, chained);
  void chained.finally(() => { if (chains.get(id) === chained) chains.delete(id); });
  return chained;
}

async function writeTurns(deps: RotateDeps, path: string, id: string, turns: PendingTurns): Promise<PdfRotationOutcome> {
  const {
    getVaultActivation, readFileSnapshot, notifyRef, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef,
    documentBuffers, documentSessions, setTabs, nativePoliciesRef, bytesGenerationsRef, bumpBytesGeneration,
    flushingRef, writeFileVersionedRef, diskStateRef, setDiskState, pdfSeedForRef,
  } = deps;
  const failed: PdfRotationOutcome = { kind: 'failed' };
  const tab = tabsRef.current.find(t => t.id === id && t.file.path === path);
  const handle = tab?.file.handle as FileSystemFileHandle | undefined;
  if (!tab || !handle) return failed;
  // Do this before anything else: a canvas checkpoint uses the per-tab chain too, and must not run inside a rotation.
  try { await getView(path)?.flushPending?.(); }
  catch { notifyRef.current('The PDF annotations could not be saved. Keep the file open and retry before rotating.'); return failed; }
  const rootAtCall = rootHandleRef.current, vaultAtCall = currentVaultIdRef.current;
  const activationAtCall = getVaultActivation(), epochAtCall = readerEpochRef.current.epoch;
  const session = documentSessions.get(id), generation = session?.bytesGeneration;
  const revision = documentBuffers.revisionForDocument(id)?.revision;
  if (!session || generation === undefined || !rootAtCall || !vaultAtCall || readPdfSessionRoute(session) !== 'tiled') {
    notifyRef.current('This PDF is not ready to rotate. Try again in a moment.'); return failed;
  }
  if (diskStateRef.current.get(id)) { notifyRef.current('This PDF has changed on disk. Deal with that first, then rotate it.'); return failed; }
  // Unsaved bytes, a save in flight or strokes the view still holds: as preparePdfPrint, not the tab's combined dirty
  // flag, which also counts a retained Annotate session's background journalling and refused every turn of an
  // annotated PDF with "still being saved" (seen after its ink had been written) instead of saying why it is refused.
  const pendingInk = () => documentBuffers.isDirty(id) || flushingRef.current.has(id) || !!getView(path)?.hasPendingEdits?.() ||
    documentBuffers.revisionForDocument(id)?.revision !== revision;
  if (pendingInk()) { notifyRef.current('This PDF has annotations still being saved. Try again in a moment.'); return failed; }
  const current = () => rootHandleRef.current === rootAtCall && currentVaultIdRef.current === vaultAtCall &&
    getVaultActivation() === activationAtCall && readerEpochRef.current.epoch === epochAtCall &&
    documentSessions.get(id) === session && session.bytesGeneration === generation && !diskStateRef.current.has(id) &&
    tabsRef.current.some(t => t.id === id && t.file.path === path && t.file.handle === handle);
  const controller = new AbortController();
  const check = () => { if (!current()) { controller.abort(); throw new DOMException('The PDF rotation source changed', 'AbortError'); } };
  let snapshot: Awaited<ReturnType<typeof readFileSnapshot>> | undefined;
  try {
    const seeded = await pdfSeedForRef.current(id);
    check();
    const expected = getBaseline(id) ?? seeded ?? null;
    if (!expected) throw new Error('The PDF disk baseline is unavailable.');
    snapshot = await readFileSnapshot(handle, controller.signal);
    check();
    // The same rule writeFileVersioned applies: an unchanged stat is the baseline; only a changed one is hashed
    // (measured: hashing first cost ~100ms of a 5MB scan's turn, before any work).
    if (!sameStat(snapshot.stat, expected) && (await snapshot.fingerprint(controller.signal)).hash !== expected.hash) {
      check(); setDiskState(id, 'conflict'); return failed;
    }
    check();
    const [{ rotatePdfIncrementally }] = await Promise.all([loadChunk(() => import('../pdf/writing/rotationClient'))]);
    check();
    const result = await rotatePdfIncrementally({ source: snapshot.blob.slice(0, snapshot.blob.size, 'application/pdf'),
      turns: { all: turns.all % 4, pages: [...turns.pages].map(([page, amount]) => [page, amount % 4] as [number, number]) }, signal: controller.signal });
    check();
    if (result.kind === 'refused') { notifyRef.current(rotationRefusal(result.cause)); return failed; }
    if (result.kind === 'unchanged') return { kind: 'unchanged' };
    if (pendingInk()) { notifyRef.current('This PDF has annotations still being saved. Try again in a moment.'); return failed; }
    if (__BME_BENCH__) {
      try { reportVault({ op: 'write', path, caller: 'rotate' }); } catch { /* Measurement must not interrupt a write. */ }
    }
    const written = await writeFileVersionedRef.current(handle, result.bytes, expected);
    if (written.status !== 'written') { setDiskState(id, written.status === 'changed' ? 'conflict' : 'deleted'); return failed; }
    const applied = { all: turns.all, pages: new Map(turns.pages) };
    if (!tabsRef.current.some(t => t.id === id)) return { kind: 'written', hash: written.version.hash, from: generation, to: generation, turns: applied };
    setBaseline(id, written.version);
    const existing = documentSessions.get(id);
    const replaceNative = existing?.kind === 'pdf' && hasHostedNativeOwner(existing, id);
    const route = replaceNative ? readPdfSessionRoute(existing) : undefined;
    // The new bytes are adopted in place, as after any other save of this document (useSaveFunnel): a new byte
    // generation rebinds the pane's source under the turned picture; a `diskRev` remount would rebuild the whole pane.
    bumpBytesGeneration(id);
    if (replaceNative) {
      // A retained Annotate owner holds the old page geometry; it starts again on the turned pages.
      nativePoliciesRef.current.delete(id);
      documentBuffers.report(id, '', true);
      const next = documentSessions.replace(id, 'pdf', bytesGenerationsRef.current.get(id) ?? 0,
        owner => createCanvasSessionBridge(owner, () => documentBuffers.get(id)?.source ?? ''));
      ensurePdfSessionRoute(next, route);
      documentBuffers.setOwner(id, { documentId: id, session: next.serial });
      next.setSlot(RECOVERY_SESSION_BINDING, bindRecoveryAdapter(id, next.adapter), dispose => dispose());
      setTabs(prev => prev.map(t => t.id === id ? { ...t, representation: { ...t.representation,
        nativeCanvasKind: undefined, nativeCanvasSession: undefined, emergencyReadOnly: undefined } } : t));
    }
    recordFileWritten(path, written.version.lastModified);
    // The parked original predates the rotation, and the next annotation save would rebuild the old orientation over this one.
    clearPdfRenderData(path);
    bumpSaveEpoch();
    return { kind: 'written', hash: written.version.hash, from: generation, to: bytesGenerationsRef.current.get(id) ?? generation + 1, turns: applied };
  } finally { snapshot?.dispose(); controller.abort(); }
}
