// Main-thread handle on the PDF-building worker.
//
// One worker for the whole app, started on first use and kept warm — spinning up
// a worker per save would re-pay module init (pdf-lib is ~400kB) every time.

import type { NotebookPaper } from './paper';
import type { NotebookSource } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';
import type { PdfBuildRequest, PdfBuildResponse } from './pdfBuild.worker';
import { PDF_EDITABLE_JSON_LIMIT, PDF_PRISTINE_LIMIT, pdfOuterForSource, type PdfRole, type PdfWriteSafety } from './pdfRole';
import { PdfBuildRefused, pdfSnapshotRefusal, type PdfBuildRefusal } from './pdfBuildRefusal';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const rolePending = new Map<number, { resolve: (role: PdfRole) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>;
    generation: string; source: Uint8Array; validating: boolean }>();
const buildAliases = new WeakMap<Uint8Array, string[]>();
export function pdfBuildAliases(bytes: Uint8Array): string[] { return buildAliases.get(bytes) ?? []; }

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}
function safetyOf(value: unknown): PdfWriteSafety | undefined {
    if (!object(value) || !fields(value, ['kind', 'reason'])) return;
    if (value.kind === 'safe' && !Object.hasOwn(value, 'reason')) return { kind: 'safe' };
    if ((value.kind === 'signed' || value.kind === 'encrypted' || value.kind === 'unknown') &&
        (value.reason === undefined || typeof value.reason === 'string' && value.reason.length <= 4096)) {
        return { kind: value.kind, ...(value.reason !== undefined ? { reason: value.reason as string } : {}) };
    }
}
function validatedRefusal(value: unknown): PdfBuildRefusal | undefined {
    if (!object(value)) return;
    if (value.reason === 'editable-json-limit' && fields(value, ['reason', 'limit']) && value.limit === PDF_EDITABLE_JSON_LIMIT)
        return { reason: 'editable-json-limit', limit: PDF_EDITABLE_JSON_LIMIT };
    if (value.reason === 'unsafe-pdf' && fields(value, ['reason', 'safety']) &&
        (value.safety === 'signed' || value.safety === 'encrypted' || value.safety === 'unknown'))
        return { reason: 'unsafe-pdf', safety: value.safety };
}
function invalidRole(generation: string): PdfRole {
    return { kind: 'unreadable', generation, alreadyAnnotated: true, attachment: 'PDF', reason: 'policy' };
}
function validMark(value: unknown): boolean {
    if (!object(value)) return false;
    if (value.kind === 'missing') return fields(value, ['kind']);
    if (value.kind === 'verified') return fields(value, ['kind', 'writeId']) &&
        (value.writeId === undefined || typeof value.writeId === 'string' && /^[0-9a-f]{32}$/.test(value.writeId));
    return value.kind === 'foreign' && fields(value, ['kind', 'reason']) &&
        (value.reason === 'mismatch' || value.reason === 'unsupported' || value.reason === 'malformed');
}
function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 10000 && value.every(item => typeof item === 'string' && item.length <= 4096);
}
async function validateRole(value: unknown, generation: string, source: Uint8Array, live: () => boolean): Promise<PdfRole> {
    const invalid = () => invalidRole(generation);
    if (!object(value) || value.generation !== generation) return invalid();
    const safety = value.writeSafety === undefined ? undefined : safetyOf(value.writeSafety);
    if (value.writeSafety !== undefined && !safety) return invalid();
    const common = { generation, ...(safety ? { writeSafety: safety } : {}) };
    if (value.kind === 'plain' || value.kind === 'annotated') {
        if (!safety || !fields(value, ['kind', 'generation', 'writeSafety', 'alreadyAnnotated', 'original', 'snapshot', 'notebookSource', 'writeMark']) ||
            !(value.original instanceof Uint8Array) || !value.original.byteLength || value.original.byteLength > PDF_PRISTINE_LIMIT ||
            typeof value.snapshot !== 'string' || value.snapshot.length > PDF_EDITABLE_JSON_LIMIT || value.notebookSource !== null) return invalid();
        if (value.kind === 'plain') {
            if (value.alreadyAnnotated !== false || value.snapshot !== '' || Object.hasOwn(value, 'writeMark') || value.original.length !== source.length) return invalid();
            // The plain role must contain the actual inspected source, not merely a same-sized substitute.
            for (let start = 0; start < source.length; start += 8 * 1024 * 1024) {
                if (!live()) return invalid();
                const end = Math.min(start + 8 * 1024 * 1024, source.length);
                for (let i = start; i < end; i++) if (source[i] !== value.original[i]) return invalid();
                if (end < source.length) await new Promise<void>(resolve => {
                    const channel = new MessageChannel();
                    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
                    channel.port2.postMessage(0);
                });
            }
            return { kind: 'plain', generation, writeSafety: safety, alreadyAnnotated: false, original: value.original, snapshot: '', notebookSource: null };
        }
        if (value.alreadyAnnotated !== true || !validMark(value.writeMark)) return invalid();
        return { kind: 'annotated', generation, writeSafety: safety, alreadyAnnotated: true, original: value.original,
            snapshot: value.snapshot, notebookSource: null, writeMark: { ...(value.writeMark as Extract<PdfRole, { kind: 'annotated' }>['writeMark']) } };
    }
    if (value.alreadyAnnotated !== true) return invalid();
    if (value.kind === 'notebookExport' && fields(value, ['kind', 'generation', 'writeSafety', 'alreadyAnnotated', 'notebookSource']) &&
        object(value.notebookSource) && fields(value.notebookSource, ['path', 'exportedAt']) && typeof value.notebookSource.path === 'string' &&
        value.notebookSource.path.length <= 4096 && value.notebookSource.path.toLowerCase().endsWith('.notebook') &&
        !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(value.notebookSource.path) && !value.notebookSource.path.includes('\\') &&
        ![...value.notebookSource.path].some(char => char.charCodeAt(0) < 32) &&
        !value.notebookSource.path.split('/').some(part => !part || part === '.' || part === '..' || ['.Assets', '.Garbage', '.VaultAgent', '.appearance.json'].includes(part)) &&
        typeof value.notebookSource.exportedAt === 'number' && Number.isFinite(value.notebookSource.exportedAt) && value.notebookSource.exportedAt >= 0) {
        return { ...common, kind: 'notebookExport', alreadyAnnotated: true, notebookSource: { path: value.notebookSource.path, exportedAt: value.notebookSource.exportedAt } };
    }
    if (value.kind === 'unreadable' && fields(value, ['kind', 'generation', 'writeSafety', 'alreadyAnnotated', 'attachment', 'attachmentId', 'reason', 'detail']) &&
        typeof value.attachment === 'string' && value.attachment.length <= 4096 &&
        (value.attachmentId === undefined || typeof value.attachmentId === 'string' && value.attachmentId.length <= 4096) &&
        (value.detail === undefined || typeof value.detail === 'string' && value.detail.length <= 4096) &&
        ['missing', 'null', 'corrupt', 'limit', 'timeout', 'workerDeath', 'schema', 'encrypted', 'policy'].includes(value.reason as string)) {
        return { ...common, kind: 'unreadable', alreadyAnnotated: true, attachment: value.attachment,
            reason: value.reason as Extract<PdfRole, { kind: 'unreadable' }>['reason'],
            ...(value.attachmentId !== undefined ? { attachmentId: value.attachmentId as string } : {}), ...(value.detail !== undefined ? { detail: value.detail as string } : {}) };
    }
    if (value.kind === 'ambiguous' && fields(value, ['kind', 'generation', 'writeSafety', 'alreadyAnnotated', 'candidates']) && strings(value.candidates))
        return { ...common, kind: 'ambiguous', alreadyAnnotated: true, candidates: [...value.candidates] };
    if (value.kind === 'newer' && fields(value, ['kind', 'generation', 'writeSafety', 'alreadyAnnotated', 'attachments']) && strings(value.attachments))
        return { ...common, kind: 'newer', alreadyAnnotated: true, attachments: [...value.attachments] };
    return invalid();
}

function failWorker(error: Error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    for (const entry of rolePending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    rolePending.clear();
    if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
    }
    worker = null;
}

function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./pdfBuild.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PdfBuildResponse>) => {
        const { id, bytes, aliases, error, role, refusal } = e.data;
        const inspection = rolePending.get(id);
        if (inspection) {
            if (inspection.validating) return;
            if (error !== undefined || !role) {
                clearTimeout(inspection.timer);
                rolePending.delete(id);
                inspection.reject(new Error(error ?? 'Missing PDF role response'));
            } else {
                inspection.validating = true;
                void validateRole(role, inspection.generation, inspection.source, () => rolePending.get(id) === inspection).then(validated => {
                    if (rolePending.get(id) !== inspection) return;
                    clearTimeout(inspection.timer);
                    rolePending.delete(id);
                    inspection.resolve(validated);
                }, () => {
                    if (rolePending.get(id) !== inspection) return;
                    clearTimeout(inspection.timer);
                    rolePending.delete(id);
                    inspection.resolve(invalidRole(inspection.generation));
                });
            }
            return;
        }
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (refusal !== undefined) {
            const validated = validatedRefusal(refusal);
            if (validated) entry.reject(new PdfBuildRefused(validated));
            else entry.reject(new Error('Invalid PDF build refusal'));
        } else if (error !== undefined || !bytes) entry.reject(new Error(error ?? 'Missing PDF build response'));
        else {
            if (aliases?.length) buildAliases.set(bytes, aliases);
            entry.resolve(bytes);
        }
    };
    worker.onerror = (e) => {
        // A worker-level failure kills every in-flight build; fail them all
        // rather than leave saves hanging forever.
        failWorker(new Error(`PDF worker failed: ${e.message}`));
    };
    worker.onmessageerror = () => failWorker(new Error('PDF worker response could not be read'));
    return worker;
}

/** Read-only union inventory in the same warm worker as the assembler. */
export function inspectPdfRoleAsync(bytes: Uint8Array, generation: string): Promise<PdfRole> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        // A dead/stalled inventory is a refusal, never permission to draw on
        // stamped outer pages. Terminating also releases an unbounded decoder.
        const timer = setTimeout(() => failWorker(new Error('PDF role read timed out')), 30000);
        rolePending.set(id, { resolve, reject, timer, generation, source: bytes, validating: false });
        try { getWorker().postMessage({ kind: 'inspect-role', id, bytes, generation } satisfies PdfBuildRequest); }
        catch (error) { failWorker(error instanceof Error ? error : new Error(String(error))); }
    });
}

/**
 * Build an annotated PDF off the main thread.
 *
 * `original` and `overlays` are structured-cloned (copied), NOT transferred:
 * the caller's copy of `original` lives in the render cache and is reused by
 * every subsequent save, and transferring would detach it.
 */
export function buildAnnotatedPdfAsync(
    original: Uint8Array,
    snapshot: string,
    overlays: Array<PageOverlay | undefined>,
): Promise<Uint8Array> {
    const refusal = pdfSnapshotRefusal(snapshot);
    if (refusal) return Promise.reject(new PdfBuildRefused(refusal));
    return dispatch(id => ({ kind: 'annotate', id, original, outer: pdfOuterForSource(original), snapshot, overlays }));
}

/**
 * Write a notebook out as a PDF, off the main thread.
 *
 * Shares the annotated-PDF worker rather than starting a second one: both jobs
 * are pdf-lib, so a separate worker would re-pay ~400kB of module init to do the
 * same work.
 */
export function buildNotebookPdfAsync(
    paper: NotebookPaper,
    overlays: Array<PageOverlay | undefined>,
    source?: NotebookSource,
): Promise<Uint8Array> {
    return dispatch(id => ({ kind: 'notebook', id, paper, overlays, source }));
}

function dispatch(build: (id: number) => PdfBuildRequest, transfer: Transferable[] = []): Promise<Uint8Array> {
    const id = nextId++;
    const request = build(id);
    return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => failWorker(new Error('PDF build timed out; the PDF was not changed. Retry saving.')), 120_000);
        pending.set(id, { resolve, reject, timer });
        try { getWorker().postMessage(request, transfer); }
        catch (error) { failWorker(error instanceof Error ? error : new Error(String(error))); }
    });
}
