import type { PageDisplayItem, PathCommand, Rgba } from '../../platform/types';

export type OutlinePiece = PageDisplayItem
    | { readonly kind: 'textPathStart'; readonly fill: Rgba; readonly blend: 'normal' | 'multiply' }
    | { readonly kind: 'textPathChunk'; readonly commands: readonly PathCommand[] }
    | { readonly kind: 'textPathEnd' };

export function isOutlinePathPiece(piece: OutlinePiece): piece is Exclude<OutlinePiece, PageDisplayItem> {
    return piece.kind === 'textPathStart' || piece.kind === 'textPathChunk' || piece.kind === 'textPathEnd';
}
