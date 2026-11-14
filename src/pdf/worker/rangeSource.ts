import { PdfEngineError } from '../engine/types';
import type { ByteSource } from '../engine/types';

const BLOCK = 64 * 1024, CACHE = 8 * 1024 * 1024;
interface SyncReader { readAsArrayBuffer(blob: Blob): ArrayBuffer }

/** One immutable Blob reference per worker document; bounded synchronous ranges
 * satisfy the native callback without a parent round trip or whole-file copy. */
export class PdfBlobSource implements ByteSource {
    readonly size: number;
    private readonly blocks = new Map<number, Uint8Array>();
    private readonly reader: SyncReader;
    private used = 0;
    private closed = false;
    private failed = false;
    constructor(private blob: Blob) {
        if (!(blob instanceof Blob) || blob instanceof File || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > 0x7fffffff) {
            throw new PdfEngineError('ResourceLimit', 'PDF source exceeds its supported size');
        }
        this.size = blob.size;
        const ctor = (globalThis as unknown as { FileReaderSync?: new () => SyncReader }).FileReaderSync;
        if (!ctor) throw new PdfEngineError('EngineBroken', 'Synchronous worker byte access is unavailable');
        this.reader = new ctor();
    }
    get cachedBytes(): number { return this.used; }
    read(offset: number, length: number): Uint8Array {
        if (this.closed || this.failed) throw new PdfEngineError('FileError', 'PDF source is no longer readable');
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
            length > 4 * 1024 * 1024 || offset + length > this.size) throw new PdfEngineError('FileError', 'Invalid PDF byte range');
        const result = new Uint8Array(length);
        try {
            let copied = 0;
            while (copied < length) {
                const position = offset + copied, start = Math.floor(position / BLOCK) * BLOCK;
                let block = this.blocks.get(start);
                if (block) this.blocks.delete(start);
                else {
                    const end = Math.min(this.size, start + BLOCK);
                    block = new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(start, end)));
                    if (block.byteLength !== end - start) throw new Error('Unreadable immutable PDF range');
                    this.used += block.byteLength;
                }
                this.blocks.set(start, block);
                while (this.used > CACHE) {
                    const key = this.blocks.keys().next().value!;
                    this.used -= this.blocks.get(key)!.byteLength; this.blocks.delete(key);
                }
                const local = position - start, take = Math.min(length - copied, block.byteLength - local);
                result.set(block.subarray(local, local + take), copied); copied += take;
            }
            return result;
        } catch {
            this.failed = true; this.blocks.clear(); this.used = 0;
            throw new PdfEngineError('FileError', 'PDF immutable source read failed');
        }
    }
    close(): void {
        if (this.closed) return;
        this.closed = true; this.blocks.clear(); this.used = 0; this.blob = new Blob();
    }
}
