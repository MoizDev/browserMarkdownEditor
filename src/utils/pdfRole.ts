// This module is deliberately library-free: App's write/rotate funnels can
// inspect a loaded capability without importing either PDF implementation.
import type { NotebookSource } from './pdfFormat';
import type { PdfWriteMarkCheck } from './pdfWriteMark';
import type { DiskVersion } from './diskVersion';

export const PDF_EDITABLE_JSON_LIMIT = 32 * 1024 * 1024;
// Retain the current assembler's structural profile; never substitute a small
// arbitrary reader cap that would strand a previously annotatable scan.
export const PDF_PRISTINE_LIMIT = 0x7fffffff;
export type PdfRoleFailure = 'missing' | 'null' | 'corrupt' | 'limit' | 'timeout' | 'workerDeath' | 'schema' | 'encrypted';
interface RoleIdentity { generation: string }
interface WritablePdfRole extends RoleIdentity {
    original: Uint8Array;
    snapshot: string;
    notebookSource: null;
}
export type PdfRole =
    | (WritablePdfRole & { kind: 'plain'; alreadyAnnotated: false })
    | (WritablePdfRole & { kind: 'annotated'; alreadyAnnotated: true; writeMark: PdfWriteMarkCheck })
    | (RoleIdentity & { kind: 'notebookExport'; notebookSource: NotebookSource; alreadyAnnotated: true })
    | (RoleIdentity & { kind: 'unreadable'; attachment: string; attachmentId?: string; reason: PdfRoleFailure; detail?: string; alreadyAnnotated: true })
    | (RoleIdentity & { kind: 'ambiguous'; candidates: string[]; alreadyAnnotated: true })
    | (RoleIdentity & { kind: 'newer'; attachments: string[]; alreadyAnnotated: true });
export type EditablePdfRole = Extract<PdfRole, { kind: 'plain' | 'annotated' }>;
export interface PdfAnnotationPreflight { role: EditablePdfRole; version: DiskVersion }

export function isEditablePdfRole(role: PdfRole): role is EditablePdfRole {
    return role.kind === 'plain' || role.kind === 'annotated';
}
export function canRotatePdfRole(role: PdfRole): boolean { return role.kind === 'plain'; }

// The canvas parks this exact Uint8Array in pdfRenderCache. Refused roles never
// own an original at all, and cannot manufacture a save capability by name.
const writableSources = new WeakSet<Uint8Array>();
export function authorizePdfRole(role: PdfRole): void {
    if (isEditablePdfRole(role) && (role.kind === 'plain' || role.writeMark.kind !== 'foreign')) writableSources.add(role.original);
}

/** App calls only after keeping the exact baseline bytes in Trash and checking
 *  the current document/owner again. This never blesses a different generation. */
export function authorizeKeptPdfRole(role: PdfRole, generation: string): boolean {
    if (role.kind !== 'annotated' || role.writeMark.kind !== 'foreign' || !generation || role.generation !== generation) return false;
    writableSources.add(role.original);
    return true;
}
export function revokePdfSource(original: Uint8Array): void { writableSources.delete(original); }
export function revokePdfRole(role: PdfRole): void {
    if (isEditablePdfRole(role)) revokePdfSource(role.original);
}
export function canRebuildAnnotatedPdf(original: Uint8Array): boolean {
    return writableSources.has(original);
}

export function pdfRoleNotice(role: PdfRole): string | undefined {
    if (role.kind === 'ambiguous') return 'This PDF contains conflicting embedded originals or annotations. It is read-only for Annotate; it has not been changed. Use recovery to choose the correct annotations.';
    if (role.kind === 'newer' || role.kind === 'unreadable' && role.reason === 'schema') return 'This PDF contains annotations written by a newer or unsupported version. It is read-only for Annotate; you can still read the PDF. Use a compatible version or recover the annotations before editing.';
    if (role.kind !== 'unreadable') return;
    if (role.reason === 'missing' && role.attachment !== 'original.pdf') return 'This PDF contains an original.pdf attachment but no supported editable annotations. It is open read-only for Annotate so its pages are not replaced. You can still read the PDF. Use a compatible version or recover the annotations before editing.';
    if (role.reason === 'limit') return `The embedded ${role.attachment} exceeds the supported bound (${role.detail}). This PDF is read-only for Annotate; it has not been changed.`;
    if (role.reason === 'encrypted') return 'This PDF is encrypted. It is read-only for Annotate; it has not been changed.';
    return 'The embedded original or annotations could not be read. This PDF is read-only for Annotate; it has not been changed. Retry or use recovery.';
}

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate data only. Never import the legacy editor to authorize a source. */
export function compatibleLegacySnapshot(value: unknown): boolean {
    if (!object(value) || !object(value.document)) return false;
    const { schema, store } = value.document;
    if (!object(schema) || !object(store) || schema.schemaVersion !== 2 || !object(schema.sequences)) return false;
    if (!Object.hasOwn(schema.sequences, 'com.tldraw.store') || !Object.hasOwn(schema.sequences, 'com.tldraw.document')) return false;
    for (const [name, version] of Object.entries(schema.sequences)) {
        const max = LEGACY_SEQUENCE_VERSIONS[name];
        if (!Object.hasOwn(LEGACY_SEQUENCE_VERSIONS, name) || max === undefined || !Number.isInteger(version) || (version as number) < 0 || (version as number) > max) return false;
    }
    for (const [id, record] of Object.entries(store)) {
        if (!object(record) || record.id !== id || typeof record.typeName !== 'string' || !id.startsWith(`${record.typeName}:`)) return false;
        if (!['document', 'page', 'shape', 'asset', 'binding', 'user', 'camera', 'instance', 'instance_page_state', 'instance_presence', 'pointer'].includes(record.typeName)) return false;
        if (record.meta !== undefined && !object(record.meta)) return false;
        if (record.typeName === 'page' && (typeof record.name !== 'string' || typeof record.index !== 'string')) return false;
        if (record.typeName === 'asset' && (typeof record.type !== 'string' || !object(record.props))) return false;
        if (record.typeName === 'binding' && (typeof record.fromId !== 'string' || typeof record.toId !== 'string' || !object(record.props))) return false;
        if (record.typeName === 'shape') {
            if (typeof record.type !== 'string' || !LEGACY_SHAPES.has(record.type) || !object(record.props)) return false;
            if (![record.x, record.y, record.rotation].every(n => typeof n === 'number' && Number.isFinite(n))) return false;
            if (typeof record.parentId !== 'string' || !/^(page|shape):/.test(record.parentId) || typeof record.index !== 'string') return false;
            if (record.isLocked !== undefined && typeof record.isLocked !== 'boolean') return false;
            if (record.type === 'draw' && !Array.isArray(record.props.segments)) return false;
        }
    }
    // JSON.parse accepts 1e999 as Infinity. Never feed non-finite coordinates
    // or dimensions into an editor, even under an otherwise supported schema.
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    while (pending.length) {
        const current = pending.pop();
        if (typeof current === 'number' && !Number.isFinite(current)) return false;
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) return false;
        seen.add(current);
        if (Array.isArray(current) && current.length > PDF_EDITABLE_JSON_LIMIT / 2) return false;
        for (const item of Object.values(current)) pending.push(item);
    }
    return true;
}

// Filled from the serialized schema of the real baseline UI control, not the
// editor's implementation. Future/unknown declarations must never downgrade.
const LEGACY_SEQUENCE_VERSIONS: Record<string, number> = {
    'com.tldraw.store': 5, 'com.tldraw.asset': 1, 'com.tldraw.camera': 1,
    'com.tldraw.document': 2, 'com.tldraw.instance': 26, 'com.tldraw.instance_page_state': 5,
    'com.tldraw.page': 1, 'com.tldraw.instance_presence': 6, 'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4, 'com.tldraw.user': 1, 'com.tldraw.asset.image': 6,
    'com.tldraw.asset.video': 5, 'com.tldraw.asset.bookmark': 2, 'com.tldraw.shape.group': 0,
    'com.tldraw.shape.text': 4, 'com.tldraw.shape.bookmark': 2, 'com.tldraw.shape.geo': 11,
    'com.tldraw.shape.note': 13, 'com.tldraw.shape.line': 5, 'com.tldraw.shape.frame': 1,
    'com.tldraw.shape.arrow': 8, 'com.tldraw.shape.highlight': 4, 'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.video': 4, 'com.tldraw.shape.draw': 5, 'com.tldraw.shape.image': 5,
    'com.tldraw.binding.arrow': 1,
};
const LEGACY_SHAPES = new Set(['draw', 'geo', 'text', 'image', 'arrow', 'line', 'note', 'frame', 'group', 'highlight', 'bookmark', 'embed', 'video']);
