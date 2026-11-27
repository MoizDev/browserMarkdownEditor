import type { PageGeometry } from '../../platform/types';
import { Sha256 } from '../../utils/sha256';
import { validNotebookSourcePath } from './notebookPointer';
import type { WriterOperations } from './protocol';

export type NotebookOutputSpec = { path: string; pages: readonly { width: number; height: number }[] };

export function notebookOutputSpec(args: WriterOperations['writer.buildNotebook']['args']): NotebookOutputSpec {
    if (!args || typeof args !== 'object' || Array.isArray(args) || !Number.isSafeInteger(args.revision) || args.revision < 0 ||
        typeof args.writeId !== 'string' || !/^[0-9a-f]{32}$/.test(args.writeId) || !args.notebookSource ||
        typeof args.notebookSource !== 'object' || Array.isArray(args.notebookSource) ||
        Object.keys(args.notebookSource).some(key => key !== 'path') || !validNotebookSourcePath(args.notebookSource.path) ||
        args.notebookSource.path.length > 4096 || !Array.isArray(args.pages) || !args.pages.length || args.pages.length > 100_000) {
        throw new Error('Invalid notebook output specification');
    }
    if (args.kind === 'pre-emitted') {
        if (Object.keys(args).some(key => !['kind', 'pdf', 'pages', 'revision', 'notebookSource', 'writeId'].includes(key)) ||
            !(args.pdf instanceof Blob) || typeof File !== 'undefined' && args.pdf instanceof File || args.pdf.size < 8 || args.pdf.size >= 0x80000000) {
            throw new Error('Invalid emitted notebook source');
        }
    } else if ((args.kind !== undefined && args.kind !== 'display') || args.displayListSchema !== 1 ||
        Object.keys(args).some(key => !['kind', 'displayListSchema', 'pages', 'revision', 'notebookSource', 'writeId'].includes(key))) {
        throw new Error('Invalid notebook display source');
    }
    const pages = args.pages.map(page => {
        if (!page || typeof page !== 'object' || Array.isArray(page) ||
            args.kind === 'pre-emitted' && Object.keys(page).some(key => key !== 'width' && key !== 'height') ||
            !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
            !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400) throw new Error('Invalid notebook page dimensions');
        return { width: page.width, height: page.height };
    });
    return { path: args.notebookSource.path, pages };
}

export async function hashNotebookOutput(buffer: ArrayBuffer, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8 || buffer.byteLength >= 0x80000000) throw new Error('Invalid notebook output bytes');
    const bytes = new Uint8Array(buffer), header = [37, 80, 68, 70, 45];
    if (header.some((value, i) => bytes[i] !== value)) throw new Error('Notebook output is not a PDF');
    const hash = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        signal.throwIfAborted();
        hash.update(bytes.subarray(offset, offset + 1024 * 1024));
        await new Promise<void>(resolve => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
            channel.port2.postMessage(0);
        });
    }
    signal.throwIfAborted();
    return hash.digest();
}

export function verifyNotebookGeometry(spec: NotebookOutputSpec, pages: readonly PageGeometry[]): void {
    if (pages.length !== spec.pages.length) throw new Error('Notebook output page count does not match');
    const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.01;
    for (let index = 0; index < pages.length; index++) {
        const page = pages[index], expected = spec.pages[index], matrix = page.toUserSpace;
        if (page.index !== index || page.rotate !== 0 || page.userUnit !== 1 || matrix.length !== 6 ||
            !close(page.width, expected.width) || !close(page.height, expected.height)) throw new Error('Notebook output geometry does not match');
        for (const [x, y] of [[0, 0], [expected.width, 0], [0, expected.height], [expected.width, expected.height]]) {
            if (!close(matrix[0] * x + matrix[2] * y + matrix[4], x) ||
                !close(matrix[1] * x + matrix[3] * y + matrix[5], expected.height - y)) {
                throw new Error('Notebook output page transform does not match');
            }
        }
    }
}
