import type { PageGeometry } from '../../platform/types';
import type { WriterSource } from '../../pdf/writing/protocol';
import type { RecoveryMediaAsset } from '../../utils/recoveryCopy';
import { boardRecoveryMedia, type BoardRecoveryRecipe } from '../format/recoveryRecipe';

export interface PdfRecoveryRecipe {
    readonly version: 1;
    readonly board: BoardRecoveryRecipe;
    readonly source: WriterSource;
    readonly pages: readonly PageGeometry[];
    readonly revision: number;
    readonly writeId: string;
}
export function isCopiedBlob(value: unknown): value is Blob {
    return value instanceof Blob && !(typeof File !== 'undefined' && value instanceof File);
}
export function validate(recipe: PdfRecoveryRecipe): void {
    if (!recipe || recipe.version !== 1 || !recipe.board || !recipe.source || !Array.isArray(recipe.pages)
        || !Number.isSafeInteger(recipe.revision) || recipe.revision < 0 || recipe.board.delta?.revision !== recipe.revision
        || typeof recipe.writeId !== 'string' || !/^[0-9a-f]{32}$/.test(recipe.writeId)
        || !isCopiedBlob(recipe.source.pristine) || !isCopiedBlob(recipe.source.outer) || !recipe.pages.length) {
        throw new TypeError('Invalid PDF recovery recipe');
    }
    for (let i = 0; i < recipe.pages.length; i++) {
        const page = recipe.pages[i];
        if (!page || page.index !== i || !Number.isFinite(page.width) || page.width <= 0
            || !Number.isFinite(page.height) || page.height <= 0 || !Number.isFinite(page.userUnit) || page.userUnit <= 0
            || ![0, 90, 180, 270].includes(page.rotate) || !Array.isArray(page.toUserSpace)
            || page.toUserSpace.length !== 6 || !page.toUserSpace.every(Number.isFinite)) throw new TypeError('Invalid PDF recovery page geometry');
    }
}

export function createPdfRecoveryRecipe(board: BoardRecoveryRecipe, input: Omit<PdfRecoveryRecipe, 'version' | 'board'>): PdfRecoveryRecipe {
    const recipe: PdfRecoveryRecipe = { ...input, board, version: 1 };
    validate(recipe);
    const copy = structuredClone(recipe);
    return { ...copy, source: { ...copy.source, pristine: copy.source.pristine.slice(0, copy.source.pristine.size, copy.source.pristine.type),
        outer: copy.source.outer.slice(0, copy.source.outer.size, copy.source.outer.type) } };
}

export function pdfRecoveryMedia(payload: unknown): readonly RecoveryMediaAsset[] {
    const recipe = payload as PdfRecoveryRecipe;
    validate(recipe);
    return boardRecoveryMedia(recipe.board);
}
