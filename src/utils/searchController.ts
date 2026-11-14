import type { TextRange } from '../types';
import type { ContentMatch } from './vaultSearch';
import type { IndexSession } from './vaultIndex/types';

export interface SearchRow { path: string; nameMatch: TextRange | null; matches: ContentMatch[]; clipped: boolean }
export interface SearchBatch {
    session: IndexSession; queryId: number; overlayRevs: Record<string, number>;
    batch: SearchRow[]; done: boolean; clipped: boolean; matchCount: number; reset?: boolean;
}

/** Stable app-owned access; no editor state travels through the file tree. */
export interface SearchController {
    search(query: string, onBatch: (batch: SearchBatch) => void, signal: AbortSignal): Promise<void>;
    subscribe(listener: () => void): () => void;
    retry(): void;
}
