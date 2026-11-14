import type { PageDisplayList } from '../../platform/types';

/** Page revision covers every logical sheet and any node crossing the physical page. */
export interface PdfInkPageCacheKey {
    readonly page: number;
    readonly pageRevision: number;
    readonly fontEpoch: number;
    readonly writerVersion: string;
}
export interface PdfInkPageCache {
    get(key: PdfInkPageCacheKey): PageDisplayList | undefined;
    put(key: PdfInkPageCacheKey, list: PageDisplayList): void;
    setDirty(dirty: boolean): void;
    /** The memory governor may evict only while the board is clean. */
    evictClean(): number;
    readonly bytes: number;
    dispose(): void;
}
