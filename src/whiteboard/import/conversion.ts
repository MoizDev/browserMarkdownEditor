import { Sha256 } from '../../utils/sha256';
import { fenceBytes } from '../format/fence';
import type { ImportedMedia } from './records/media';

export interface ConversionBackup { readonly key: string; readonly bytes: Blob }
export type VersionStatus = 'current' | 'changed' | 'gone';
export type ConversionWrite = 'saved' | 'changed' | 'gone';
export interface ConversionSnapshot {
    readonly revision: number;
    readonly dirty: boolean;
    readonly readOnly: boolean;
    readonly losses: readonly string[];
    readonly media: readonly ImportedMedia[];
    readonly board: Blob;
}
export interface ConversionIO {
    // All callbacks close over one vault, document handle and baseline, never current app selection.
    readonly checkBaseline: () => Promise<VersionStatus>;
    readonly listBackups: () => AsyncIterable<ConversionBackup>;
    readonly keepCopyInGarbage: (original: Blob) => Promise<string>;
    readonly saveMedia: (media: ImportedMedia) => Promise<void>;
    // PDF implementation adds board.json and replaces the old snapshot with this fence in one output.
    readonly buildPdf: (board: Blob, fence: Uint8Array, media: readonly ImportedMedia[]) => Promise<Blob>;
    readonly writeVersioned: (bytes: Blob) => Promise<ConversionWrite>;
    readonly confirmLoss: (losses: readonly string[]) => Promise<boolean>;
    // Host calls freeEntryName over files and folders and copies, never overwrites or removes the backup.
    readonly restoreCopyToFreeName: (backupKey: string) => Promise<string>;
    readonly saved: (revision: number, backupKey: string) => void;
}
export type ConversionResult =
    | { readonly kind: 'unchanged' | 'cancelled' | 'already-converted' }
    | { readonly kind: 'conflict'; readonly status: 'changed' | 'gone' }
    | { readonly kind: 'converted'; readonly backupKey: string };

const CHUNK = 4 * 1024 * 1024;
async function digest(blob: Blob): Promise<string> {
    const hash = new Sha256();
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
        hash.update(new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer()));
    }
    return hash.digest();
}
async function equalBytes(a: Blob, b: Blob): Promise<boolean> {
    if (a.size !== b.size) return false;
    for (let offset = 0; offset < a.size; offset += CHUNK) {
        const left = new Uint8Array(await a.slice(offset, offset + CHUNK).arrayBuffer());
        const right = new Uint8Array(await b.slice(offset, offset + CHUNK).arrayBuffer());
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    }
    return true;
}
async function findBackup(original: Blob, io: ConversionIO): Promise<string | null> {
    let originalHash: string | undefined;
    for await (const candidate of io.listBackups()) {
        if (candidate.bytes.size !== original.size) continue;
        originalHash ??= await digest(original);
        if (await digest(candidate.bytes) === originalHash && await equalBytes(original, candidate.bytes)) return candidate.key;
    }
    return null;
}

// I-1/I-2, E-DEL-11/12: this controller holds one immutable source and one vault-bound IO closure.
export function createConversion(kind: 'whiteboard' | 'notebook' | 'pdf-ink', original: Blob, io: ConversionIO): {
    readonly converted: boolean;
    flush(snapshot: ConversionSnapshot, convertAnyway?: boolean): Promise<ConversionResult>;
    restore(backupKey: string): Promise<string>;
} {
    let converted = false;
    let tail: Promise<void> = Promise.resolve();
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const result = tail.then(task);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
    return {
        get converted() { return converted; },
        flush(snapshot, convertAnyway = false) {
            return enqueue(async (): Promise<ConversionResult> => {
                if (converted) return { kind: 'already-converted' };
                if (!snapshot.dirty && !convertAnyway) return { kind: 'unchanged' };
                if (snapshot.readOnly) {
                    if (!convertAnyway || !await io.confirmLoss(snapshot.losses)) return { kind: 'cancelled' };
                } else if (convertAnyway) return { kind: 'cancelled' };
                const status = await io.checkBaseline();
                if (status !== 'current') return { kind: 'conflict', status };
                const output = kind === 'pdf-ink' ? await io.buildPdf(snapshot.board, fenceBytes(), snapshot.media) : snapshot.board;
                const backupKey = await findBackup(original, io) ?? await io.keepCopyInGarbage(original);
                if (kind !== 'pdf-ink') for (const item of snapshot.media) await io.saveMedia(item);
                const write = await io.writeVersioned(output);
                if (write !== 'saved') return { kind: 'conflict', status: write };
                converted = true;
                io.saved(snapshot.revision, backupKey);
                return { kind: 'converted', backupKey };
            });
        },
        restore(backupKey) { return enqueue(() => io.restoreCopyToFreeName(backupKey)); },
    };
}
