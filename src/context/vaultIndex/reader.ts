import type { IndexFile } from '../../utils/vaultIndex/types';

/** The acquisition route is selected independently of the index. A stat holds
 * the same snapshot for its optional payload read; reads never mutate a vault. */
export interface IndexStat {
    mtime: number;
    size: number;
    bytes(): Promise<ArrayBuffer>;
}
export interface IndexReader {
    stat(file: IndexFile): Promise<IndexStat>;
}

/** Only the app's tree supplies handles; the worker never enumerates. */
export class HandleReader implements IndexReader {
    readonly handles = new Map<string, FileSystemFileHandle>();
    async stat(entry: IndexFile): Promise<IndexStat> {
        const handle = this.handles.get(entry.path);
        if (!handle) throw new Error('Index file handle is unavailable');
        const file = await handle.getFile();
        return { mtime: file.lastModified, size: file.size, bytes: () => file.arrayBuffer() };
    }
}
