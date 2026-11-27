import { SampleStore } from '../ink/samples';
import { createBoardLoadAdmission } from '../model/loadAdmission';
import type { BoardKind } from '../model/doc';
import type { RehydratedLoad } from '../model/loadTypes';
import { createJobAuthority } from '../security/admission';
import { createNativeLoadClient } from '../workers/nativeLoadClient';
import type { NativeLoadReply } from '../workers/nativeLoad';
import { yieldToHost } from '../../platform/yieldToHost';

export type NativeBoardAcquisition =
    | { readonly status: 'editable'; readonly load: RehydratedLoad; readonly samples: SampleStore;
        readonly report: NativeLoadReply; dispose(): void }
    | { readonly status: 'read-only'; readonly original: Blob; readonly report: NativeLoadReply; dispose(): void };

export interface NativeAcquisitionOptions {
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly identity: { readonly session: string; readonly epoch: number; readonly generation: number };
    readonly pdfPages?: readonly (readonly [number, number])[];
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
    readonly cooperate?: () => Promise<void>;
    readonly onFailure?: (error: unknown) => void;
}

export async function acquireNativeBoard(options: NativeAcquisitionOptions): Promise<NativeBoardAcquisition> {
    if (!(options.bytes instanceof Blob) || (typeof File !== 'undefined' && options.bytes instanceof File)) {
        throw new TypeError('Native acquisition requires copied bytes as a Blob, not a File');
    }
    const samples = new SampleStore();
    const authority = createJobAuthority(options.identity.session, options.identity.epoch, options.identity.generation);
    const admission = createBoardLoadAdmission(authority, {
        samples, admit: (pts, header) => samples.admitEncoded(pts, header), cooperate: options.cooperate ?? yieldToHost,
    });
    let client: ReturnType<typeof createNativeLoadClient>;
    try { client = createNativeLoadClient({ authority, admission, identity: options.identity }); }
    catch (error) { admission.dispose(); authority.dispose(); throw error; }
    let owned: RehydratedLoad | null = null, disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try { client.dispose(); } finally {
            try { admission.dispose(); } finally {
                try { authority.dispose(); } finally { owned?.release(); owned = null; }
            }
        }
    };
    try {
        const result = await client.load(options.bytes, options.kind, options.pdfPages,
            { signal: options.signal, deadlineMs: options.deadlineMs });
        owned = result.load;
        client.dispose();
        options.signal?.throwIfAborted();
        if (!result.load) return { status: 'read-only', original: options.bytes, report: result.reply, dispose };
        return { status: 'editable', load: result.load, samples, report: result.reply, dispose };
    } catch (error) {
        dispose();
        try { options.onFailure?.(error); } catch { /* Preserve the acquisition failure. */ }
        throw error;
    }
}
