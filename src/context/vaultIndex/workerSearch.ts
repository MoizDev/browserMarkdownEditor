import { searchVault, isTextFile } from '../../utils/vaultSearch';
import { isCanvasFile } from '../../utils/fileTypes';
import type { FileTreeFileNode, TextRange } from '../../types';
import type { ContentMatch } from '../../utils/vaultSearch';
import type { IndexFile, IndexSession } from '../../utils/vaultIndex/types';
import type { WorkerContext } from '../../platform/workers/serve';
import type { SearchResidency } from './searchResidency';

export interface SearchOverlay { rev: number; text: string }
export interface SearchRow { path: string; nameMatch: TextRange | null; matches: ContentMatch[]; clipped: boolean }
export interface SearchBatch {
    session: IndexSession; queryId: number; overlayRevs: Record<string, number>;
    batch: SearchRow[]; done: boolean; clipped: boolean; matchCount: number;
}

/** Match in authoritative tree order. The consumer groups name hits first,
 * while each streamed row preserves the same caps and original offsets. */
export async function searchSidebar(session: IndexSession, queryId: number, query: string,
    files: readonly IndexFile[], text: SearchResidency, overlays: ReadonlyMap<string, SearchOverlay>,
    context: WorkerContext): Promise<void> {
    const overlayRevs = Object.fromEntries([...overlays].map(([path, overlay]) => [path, overlay.rev]));
    let matches = 0, count = 0, clipped = false;
    const emit = (batch: SearchRow[], done: boolean) => context.emit('results', {
        session, queryId, overlayRevs, batch, done, clipped, matchCount: matches,
    } satisfies SearchBatch);
    for (let i = 0; i < files.length; i++) {
        if (context.cancelled) return;
        if (count >= 200) { clipped = true; break; }
        const file = files[i];
        if (isTextFile(file.path) && !isCanvasFile(file.path) && !overlays.has(file.path)) await text.ensure([file.path]);
        if (context.cancelled) return;
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        const node = { path: file.path, name, kind: 'file' } as FileTreeFileNode;
        const value = overlays.get(file.path)?.text ?? text.snapshot().get(file.path)?.text;
        const result = searchVault([node], query, () => matches < 500 ? value : undefined);
        const row = result.files[0];
        if (matches >= 500) clipped = true;
        if (row) {
            const remaining = 500 - matches;
            const found = row.matches.slice(0, remaining);
            const limited = found.length !== row.matches.length;
            matches += found.length;
            clipped ||= result.clipped || limited;
            if (row.nameMatch || found.length) {
                count++;
                emit([{ path: file.path, nameMatch: row.nameMatch, matches: found, clipped: row.clipped || limited }], false);
            }
        }
        await context.slice();
    }
    if (!context.cancelled) emit([], true);
}
