import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { textBoundaries } from './boundaries';
import { deriveRichTextChange } from './richDiff';
import { projectionLength } from './projection';
import { mapTextSelectionTo, normalizeTextSelection, type TextAffinity, type TextSpliceMap } from './rangeMap';
import { sliceRichText, spliceRichText, type Block, type RichFragment, type RichText } from './richText';
import type { RichSelection } from './rich';

export interface RichSpliceOperation {
    readonly from: number;
    readonly to: number;
    readonly insert: RichFragment;
    /** A block-aligned replacement, including an empty block, for history or block formatting. */
    readonly wholeBlocks?: true;
}
export interface RichTransactionResult {
    readonly text: RichText;
    readonly selection: RichSelection;
    readonly inverse: readonly RichSpliceOperation[];
    readonly inverseSelection: RichSelection;
    /** Null means an operation changed formatting/metadata but not the plain projection. */
    readonly maps: readonly (TextSpliceMap | null)[];
}

const kinds = new Set<Block['kind']>(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const flags = ['b', 'i', 'u', 's', 'code', 'hl'] as const;
const markKeys = new Set<string>([...flags, 'link', 'x']);
const validFragments = new WeakSet<RichFragment>();

function rawArray(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    return trimmed.startsWith('[') && trimmed.endsWith(']');
}
function link(value: unknown): boolean {
    if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) return false;
    try {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password && (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:');
    } catch { return false; }
}
function plainRun(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit === 10) return false;
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            index++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
}
function attributes(value: Pick<Block, 'kind' | 'level' | 'dir' | 'start'>): boolean {
    return kinds.has(value.kind) && Number.isInteger(value.level) && value.level >= 0 && value.level <= 7
        && (value.kind !== 'p' || value.level === 0)
        && (value.dir === 'auto' || value.dir === 'ltr' || value.dir === 'rtl')
        && (value.start === undefined || (value.kind === 'ol' && Number.isFinite(value.start)));
}

/** Validate only the incoming immutable fragment, never rescan the whole document on each edit. */
export function validateRichFragment(fragment: RichFragment): void {
    if (validFragments.has(fragment)) return;
    if (!Array.isArray(fragment.blocks) || !fragment.blocks.length || fragment.blocks.length > MAX_TEXT_BLOCKS)
        throw new RangeError('Invalid rich fragment blocks');
    let length = fragment.blocks.length - 1;
    for (const block of fragment.blocks) {
        if (!attributes(block) || !Array.isArray(block.runs) || !block.runs.length || (block.tail !== undefined && !rawArray(block.tail)))
            throw new RangeError('Invalid rich fragment block');
        let blockLength = 0;
        for (const run of block.runs) {
            if (typeof run.text !== 'string' || !plainRun(run.text) || !run.marks || typeof run.marks !== 'object'
                || (run.tail !== undefined && !rawArray(run.tail))) throw new RangeError('Invalid rich fragment run');
            for (const key of Object.keys(run.marks)) if (!markKeys.has(key)) throw new RangeError('Invalid rich fragment mark');
            for (const flag of flags) if (run.marks[flag] !== undefined && run.marks[flag] !== true) throw new RangeError('Invalid rich fragment mark');
            if (run.marks.link !== undefined && !link(run.marks.link)) throw new RangeError('Invalid rich fragment link');
            if (run.marks.x !== undefined && typeof run.marks.x !== 'string') throw new RangeError('Invalid rich opaque mark');
            blockLength += run.text.length;
            length += run.text.length;
            if (length > MAX_TEXT_LENGTH) throw new RangeError('Rich fragment exceeds text limit');
        }
        for (const carrier of block.carriers ?? []) {
            if (!attributes(carrier) || !rawArray(carrier.tail) || !Number.isSafeInteger(carrier.from) || !Number.isSafeInteger(carrier.to)
                || carrier.from < 0 || carrier.to < carrier.from || carrier.to > blockLength) throw new RangeError('Invalid rich block carrier');
        }
    }
    validFragments.add(fragment);
}

function selectionMap(before: RichText, operation: RichSpliceOperation): TextSpliceMap | null {
    const old = sliceRichText(before, operation.from, operation.to, true);
    const local = deriveRichTextChange(old, operation.insert);
    return local ? { from: operation.from + local.from, to: operation.from + local.oldTo,
        insertedLength: local.newTo - local.from } : null;
}

/**
 * Apply a series in evolving coordinates. Every intermediate is private until
 * all operations succeed; inverse snapshots retain the original block objects,
 * including each independent unknown carrier. No history or host state is touched.
 */
export function applyRichTransaction(initial: RichText, operations: readonly RichSpliceOperation[], selection: RichSelection,
    affinity: TextAffinity = 'after'): RichTransactionResult {
    if (operations.length > 10_000) throw new RangeError('Rich transaction has too many operations');
    let text = initial, current = normalizeTextSelection(initial, selection, affinity);
    const inverseSelection = current, inverses: RichSpliceOperation[] = [], maps: (TextSpliceMap | null)[] = [];
    for (const operation of operations) {
        if (operation.to < operation.from || !textBoundaries.isBoundary(text, operation.from) || !textBoundaries.isBoundary(text, operation.to))
            throw new RangeError('Rich splice must use grapheme boundaries');
        validateRichFragment(operation.insert);
        const map = selectionMap(text, operation);
        const result = spliceRichText(text, operation.from, operation.to, operation.insert, operation.wholeBlocks === true);
        current = map ? mapTextSelectionTo(current, map, result.text, affinity) : normalizeTextSelection(result.text, current, affinity);
        maps.push(map);
        inverses.push(result.inverse);
        text = result.text;
    }
    inverses.reverse();
    return { text, selection: current, inverse: inverses, inverseSelection, maps };
}

/** Current length is available without joining the transaction's projected text. */
export function richTransactionLength(result: RichTransactionResult): number { return projectionLength(result.text); }
