import type { Affine } from '../../platform/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';

/** Writer-worker scratch only. Never retain a HEAP view across a native call:
 * PDFium can grow WASM memory and detach its previous ArrayBuffer. */
export class WriterArena {
    private readonly pointers: number[] = [];
    constructor(private readonly runtime: PdfiumRuntime) {}

    allocate(size: number): number {
        const ptr = this.runtime.malloc(size);
        this.pointers.push(ptr);
        return ptr;
    }
    bytes(data: Uint8Array): number {
        const ptr = this.allocate(Math.max(1, data.byteLength));
        this.runtime.HEAPU8.set(data, ptr);
        return ptr;
    }
    ascii(text: string): number {
        if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('PDFium key must be ASCII');
        const bytes = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return this.bytes(bytes);
    }
    wide(text: string): number {
        if (text.includes('\0')) throw new Error('PDF attachment text contains a NUL');
        const length = (text.length + 1) * 2;
        if (!Number.isSafeInteger(length) || length > 0xffffffff) throw new RangeError('PDF attachment text is too long');
        const ptr = this.allocate(length);
        const view = new DataView(this.runtime.HEAPU8.buffer);
        for (let i = 0; i < text.length; i++) view.setUint16(ptr + i * 2, text.charCodeAt(i), true);
        view.setUint16(ptr + text.length * 2, 0, true);
        return ptr;
    }
    matrix(matrix: Affine): number {
        if (matrix.length !== 6 || matrix.some(value => !Number.isFinite(value))) throw new Error('Invalid PDF ink transform');
        const spec = this.runtime.abi.structs.matrix, ptr = this.allocate(spec.size);
        const view = new DataView(this.runtime.HEAPU8.buffer);
        for (const [i, key] of (['a', 'b', 'c', 'd', 'e', 'f'] as const).entries()) {
            const rounded = Math.fround(matrix[i]);
            if (!Number.isFinite(rounded) || (matrix[i] !== 0 && rounded === 0)) throw new RangeError('PDF ink transform is outside PDFium precision');
            view.setFloat32(ptr + spec.offsets[key], rounded, true);
        }
        return ptr;
    }
    dispose(): void {
        while (this.pointers.length) this.runtime.free(this.pointers.pop()!);
    }
}
