import type { IndexFile } from '../../utils/vaultIndex/types';

export interface IndexStat {
    mtime: number;
    size: number;
    bytes(): Promise<ArrayBuffer>;
    stream(): ReadableStream<Uint8Array>;
}
export interface IndexReader {
    stat(file: IndexFile): Promise<IndexStat>;
}

export class HandleReader implements IndexReader {
    readonly handles = new Map<string, FileSystemFileHandle>();
    async stat(entry: IndexFile): Promise<IndexStat> {
        const handle = this.handles.get(entry.path);
        if (!handle) throw new Error('Index file handle is unavailable');
        const file = await handle.getFile();
        return { mtime: file.lastModified, size: file.size, bytes: () => file.arrayBuffer(), stream: () => file.stream() };
    }
}
