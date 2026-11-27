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
import { isFileReadTimeout, withinFileDeadline } from '../utils/fileReadDeadline';

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

function rotationRefusal(cause: RotationRefusal | undefined): string {
  switch (cause) {
    case 'signed': return `This PDF is signed, and turning its pages would break the signature. ${LEFT_AS_IT_IS} To rotate it, create an unsigned copy and rotate that.`;
    case 'encrypted': return `This PDF is encrypted, so its pages cannot be turned here. ${LEFT_AS_IT_IS}`;
    case 'legacy-annotations':
      return `This PDF's annotations are in the older Classic format, so its pages were not turned. Open Annotate and choose Convert legacy annotations…, then the pages turn with their annotations. ${LEFT_AS_IT_IS}`;
    case 'newer-annotations':
      return `This PDF holds annotations from a newer version of this app, which this version cannot move with the pages. ${LEFT_AS_IT_IS}`;
    case 'other-engine':
      return `This PDF's annotations were saved by another build of this app's PDF engine, so this version cannot move them with the pages. ${LEFT_AS_IT_IS}`;
    case 'foreign-change':
      return `This PDF was changed by another program after its annotations were saved here, or saved by a newer version of this app. Turning its pages now would let the next annotation save discard that change. ${LEFT_AS_IT_IS}`;
    case 'missing-attachment':
      return `The annotations saved inside this PDF are incomplete or damaged, and turning its pages could lose them. ${LEFT_AS_IT_IS}`;
    case 'unverified':
      return `The annotations saved inside this PDF could not be checked with certainty, so its pages were not turned. ${LEFT_AS_IT_IS}`;
    case 'unsupported-rotation': return `This PDF has a page at an angle that is not a quarter turn, so its pages were not turned. ${LEFT_AS_IT_IS}`;
    case 'unsafe-policy': case 'unsupported-format':
      return `This PDF has parts this app cannot rewrite with certainty (forms, permissions or an unusual structure), so its pages were not turned. ${LEFT_AS_IT_IS}`;
    default: return `This PDF could not be read well enough to turn its pages safely. ${LEFT_AS_IT_IS}`;
  }
}

function rotationFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : '', message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError') return 'The PDF changed while its pages were being turned, so nothing was saved. Try again.';
  if (isFileReadTimeout(err)) return `${message} Its pages were not turned and nothing was changed; try again once it is available.`;
  if (name === 'UnsupportedSecurity' || /encrypt/i.test(message)) return rotationRefusal('encrypted');
  if (/signed/i.test(message)) return rotationRefusal('signed');
  if (/failed verification/.test(message)) return `The turned PDF did not pass its check, so nothing was saved. ${LEFT_AS_IT_IS}`;
  if (name === 'InvalidPdf' || name === 'PageError') return rotationRefusal(undefined);
  return `Could not turn this PDF's pages (${message.replace(/[.\s]+$/, '')}). ${LEFT_AS_IT_IS}`;
}

type RotateDeps = Pick<PdfGestureDeps,
  'getVaultActivation' | 'readFileSnapshot' | 'notifyRef' | 'rootHandleRef' | 'flushTab' |
  'currentVaultIdRef' | 'readerEpochRef' | 'tabsRef' | 'documentBuffers' | 'documentSessions' | 'setTabs' |
  'nativePoliciesRef' | 'bytesGenerationsRef' | 'bumpBytesGeneration' | 'flushingRef' | 'flushChainsRef' |
  'writeFileVersionedRef' | 'diskStateRef' | 'setDiskState' | 'pdfSeedForRef'
>;

interface PendingTurns { all: number; pages: Map<number, number>; presses: number; run: Promise<void>; savedConversion?: boolean }
const pendingTurns = new Map<string, PendingTurns>();

export function rotatePdf(deps: RotateDeps, path: string, delta: number, pageIndex?: number): Promise<void> {
  const { tabsRef } = deps;
  const tab = tabsRef.current.find(t => t.file.path === path);
  if (!tab?.file.handle || !Number.isSafeInteger(delta / 90)) { if (tab) settlePdfRotationWrite(tab.id, { kind: 'failed' }, 1); return Promise.resolve(); }
  const { id } = tab, quarter = ((delta / 90) % 4 + 4) % 4;
  const queued = pendingTurns.get(id);
  if (queued) {
    if (pageIndex === undefined) queued.all += quarter; else queued.pages.set(pageIndex, (queued.pages.get(pageIndex) ?? 0) + quarter);
    queued.presses++;
    return queued.run;
  }
  const entry = { all: pageIndex === undefined ? quarter : 0, pages: new Map(pageIndex === undefined ? [] : [[pageIndex, quarter]]), presses: 1 } as PendingTurns;
  pendingTurns.set(id, entry);
  entry.run = (async () => {
    let outcome: PdfRotationOutcome = { kind: 'failed' };
    try {
      for (let round = 0; round < 3; round++) {
        if (!await saveInkBeforeTurn(deps, path, id)) return;
        const step = await queueTurn(deps, path, id, entry);
        if (step === 'save-conversion') {
          entry.savedConversion = true;
          if (await deps.flushTab(path, true) === 'written') continue;
          deps.notifyRef.current(`These annotations were converted but are not saved into the PDF until your next change in Annotate. Make one, then turn the pages: they turn with their annotations. ${LEFT_AS_IT_IS}`);
          return;
        }
        if (step !== 'pending-ink') { outcome = step; return; }
      }
      deps.notifyRef.current('This PDF has annotations still being saved. Try again in a moment.');
    } catch (err) { console.error('Could not rotate the PDF:', err); deps.notifyRef.current(rotationFailure(err)); }
    finally {
      if (pendingTurns.get(id) === entry) pendingTurns.delete(id);
      settlePdfRotationWrite(id, outcome, entry.presses);
    }
  })();
  return entry.run;
}

async function saveInkBeforeTurn(deps: RotateDeps, path: string, id: string): Promise<boolean> {
  const { tabsRef, documentBuffers, documentSessions, flushChainsRef, flushTab, notifyRef } = deps;
  try { await getView(path)?.flushPending?.(); }
  catch { notifyRef.current('The PDF annotations could not be saved. Keep the file open and retry before rotating.'); return false; }
  await drain(id);
  await flushChainsRef.current.get(id);
  const pending = () => !!tabsRef.current.find(t => t.id === id)?.dirty || documentBuffers.isDirty(id) || documentSessions.hasPendingEdits(id);
  if (!pending()) return true;
  const outcome = await flushTab(path, true);
  if (outcome === 'written' || outcome === 'skipped' && !documentBuffers.isDirty(id)) return true;
  notifyRef.current('The annotations could not be saved, so the pages were not turned. Resolve the PDF notice and try again.');
  return false;
}

function queueTurn(deps: RotateDeps, path: string, id: string, entry: PendingTurns): Promise<PdfRotationOutcome | 'pending-ink' | 'save-conversion'> {
  const chains = deps.flushChainsRef.current;
  const chained = (chains.get(id) ?? Promise.resolve()).then(() => {
    if (pendingTurns.get(id) === entry) pendingTurns.delete(id);
    return writeTurns(deps, path, id, entry);
  });
  chains.set(id, chained);
  void chained.catch(() => {}).finally(() => { if (chains.get(id) === chained) chains.delete(id); });
  return chained;
}

async function writeTurns(deps: RotateDeps, path: string, id: string, turns: PendingTurns): Promise<PdfRotationOutcome | 'pending-ink' | 'save-conversion'> {
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
  const pendingInk = () => documentBuffers.isDirty(id) || flushingRef.current.has(id) || !!getView(path)?.hasPendingEdits?.() ||
    documentBuffers.revisionForDocument(id)?.revision !== revision;
  if (pendingInk()) return 'pending-ink';
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
    if (!sameStat(snapshot.stat, expected) && (await snapshot.fingerprint(controller.signal)).hash !== expected.hash) {
      check(); setDiskState(id, 'conflict'); return failed;
    }
    check();
    const [{ rotatePdfIncrementally }] = await Promise.all([loadChunk(() => import('../pdf/writing/rotationClient'))]);
    check();
    const taken = snapshot;
    const result = await rotatePdfIncrementally({ source: taken.blob.slice(0, taken.blob.size, 'application/pdf'),
      turns: { all: turns.all % 4, pages: [...turns.pages].map(([page, amount]) => [page, amount % 4] as [number, number]) }, signal: controller.signal })
      .catch(async (err: unknown) => {
        const now = await withinFileDeadline((handle as FileSystemFileHandle).getFile(), path).catch(() => undefined);
        if (now && !sameStat({ lastModified: now.lastModified, size: now.size }, taken.stat)) {
          throw new DOMException('The PDF rotation source changed', 'AbortError');
        }
        throw err;
      });
    check();
    if (result.kind === 'refused') {
      if (result.cause === 'legacy-annotations' && !turns.savedConversion && hasHostedNativeOwner(documentSessions.get(id), id)) return 'save-conversion';
      notifyRef.current(rotationRefusal(result.cause)); return failed;
    }
    if (result.kind === 'unchanged') return { kind: 'unchanged' };
    if (pendingInk()) return 'pending-ink';
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
