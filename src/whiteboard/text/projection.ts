import type { Block, RichText } from './richText';
import { firstRunAt, runIndex } from './runIndex';

export interface TextProjectionPosition {
    readonly block: Block;
    readonly index: number;
    readonly start: number;
    readonly offset: number;
    readonly length: number;
}

interface Leaf {
    readonly kind: 'leaf';
    readonly lengths: readonly number[];
    readonly count: number;
    /** Includes one separator after the last block; the projection removes the final one. */
    readonly units: number;
    readonly height: 1;
    readonly leaves: 1;
}
interface Branch {
    readonly kind: 'branch';
    readonly left: Tree;
    readonly right: Tree;
    readonly count: number;
    readonly units: number;
    readonly height: number;
    readonly leaves: number;
}
type Tree = Leaf | Branch;
interface ProjectionIndex { readonly tree: Tree | null; readonly length: number }

const LEAF_BLOCKS = 128;
const indexes = new WeakMap<RichText, ProjectionIndex>();
const blockLengths = new WeakMap<Block, number>();

function lengthOf(block: Block): number {
    let length = blockLengths.get(block);
    if (length === undefined) {
        length = block.runs.reduce((sum, run) => sum + run.text.length, 0);
        blockLengths.set(block, length);
    }
    return length;
}
function leaf(lengths: readonly number[]): Leaf {
    let units = 0;
    for (const length of lengths) units += length + 1;
    return { kind: 'leaf', lengths, count: lengths.length, units, height: 1, leaves: 1 };
}
function branch(left: Tree, right: Tree): Branch {
    return { kind: 'branch', left, right, count: left.count + right.count, units: left.units + right.units,
        height: Math.max(left.height, right.height) + 1, leaves: left.leaves + right.leaves };
}
function balance(left: Tree, right: Tree): Tree {
    if (left.kind === 'leaf' && right.kind === 'leaf' && left.count + right.count <= LEAF_BLOCKS)
        return leaf([...left.lengths, ...right.lengths]);
    if (left.height > right.height + 1 && left.kind === 'branch') {
        const a = left.left, b = left.right;
        if (a.height >= b.height || b.kind === 'leaf') return branch(a, branch(b, right));
        return branch(branch(a, b.left), branch(b.right, right));
    }
    if (right.height > left.height + 1 && right.kind === 'branch') {
        const b = right.left, c = right.right;
        if (c.height >= b.height || b.kind === 'leaf') return branch(branch(left, b), c);
        return branch(branch(left, b.left), branch(b.right, c));
    }
    return branch(left, right);
}
function join(left: Tree | null, right: Tree | null): Tree | null {
    if (!left) return right;
    if (!right) return left;
    if (left.height > right.height + 1 && left.kind === 'branch') return balance(left.left, join(left.right, right)!);
    if (right.height > left.height + 1 && right.kind === 'branch') return balance(join(left, right.left)!, right.right);
    return balance(left, right);
}
function split(tree: Tree | null, count: number): readonly [Tree | null, Tree | null] {
    if (!tree) return [null, null];
    if (count <= 0) return [null, tree];
    if (count >= tree.count) return [tree, null];
    if (tree.kind === 'leaf') return [leaf(tree.lengths.slice(0, count)), leaf(tree.lengths.slice(count))];
    if (count === tree.left.count) return [tree.left, tree.right];
    if (count < tree.left.count) {
        const [first, rest] = split(tree.left, count);
        return [first, join(rest, tree.right)];
    }
    const [first, rest] = split(tree.right, count - tree.left.count);
    return [join(tree.left, first), rest];
}
function build(blocks: readonly Block[]): Tree | null {
    const leaves: Tree[] = [];
    for (let start = 0; start < blocks.length; start += LEAF_BLOCKS) {
        const lengths: number[] = [];
        for (let index = start; index < Math.min(blocks.length, start + LEAF_BLOCKS); index++) lengths.push(lengthOf(blocks[index]));
        leaves.push(leaf(lengths));
    }
    const make = (from: number, to: number): Tree => {
        if (to - from === 1) return leaves[from];
        const middle = from + Math.floor((to - from) / 2);
        return branch(make(from, middle), make(middle, to));
    };
    return leaves.length ? make(0, leaves.length) : null;
}
function indexed(tree: Tree | null): ProjectionIndex { return { tree, length: tree ? tree.units - 1 : 0 }; }
function indexFor(text: RichText): ProjectionIndex {
    let index = indexes.get(text);
    if (!index) { index = indexed(build(text.blocks)); indexes.set(text, index); }
    return index;
}

/** Reuse unchanged immutable block lengths after a splice, without rebuilding all prefix offsets. */
export function inheritProjection(before: RichText, after: RichText, first: number, removed: number,
    inserted: readonly Block[]): void {
    const old = indexes.get(before);
    if (!old) return;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(removed) || first < 0 || removed < 0
        || first + removed > before.blocks.length || after.blocks.length !== before.blocks.length - removed + inserted.length)
        throw new RangeError('Invalid projection splice');
    const [left, tail] = split(old.tree, first), [, right] = split(tail, removed);
    let tree = join(join(left, build(inserted)), right);
    // Repeated edits can split leaves into tiny pieces. Repack only after substantial fragmentation.
    if (tree && tree.leaves > 4 * Math.ceil(tree.count / LEAF_BLOCKS) + 32) tree = build(after.blocks);
    indexes.set(after, indexed(tree));
}

/** Newline belongs to the preceding block; the next offset starts the next block. */
export function projectionPosition(text: RichText, offset: number): TextProjectionPosition {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid text offset');
    const index = indexFor(text);
    if (!index.tree || offset > index.length) throw new RangeError('Text offset exceeds projection');
    let tree: Tree = index.tree, blockIndex = 0, start = 0, local = offset;
    while (tree.kind === 'branch') {
        if (local < tree.left.units) tree = tree.left;
        else { local -= tree.left.units; start += tree.left.units; blockIndex += tree.left.count; tree = tree.right; }
    }
    for (let i = 0; i < tree.lengths.length; i++) {
        const length = tree.lengths[i];
        if (local <= length) return { block: text.blocks[blockIndex + i], index: blockIndex + i, start, offset: local, length };
        local -= length + 1; start += length + 1;
    }
    throw new RangeError('Text offset exceeds projection');
}
export function projectionLength(text: RichText): number { return indexFor(text).length; }

/** Read only intersecting blocks; newline separators are projection characters. */
export function projectionSlice(text: RichText, from: number, to: number): string {
    if (to < from) throw new RangeError('Reversed text slice');
    const first = projectionPosition(text, from), last = projectionPosition(text, to);
    const pieces: string[] = [];
    for (let index = first.index; index <= last.index; index++) {
        const block = text.blocks[index], low = index === first.index ? first.offset : 0;
        const high = index === last.index ? last.offset : lengthOf(block);
        if (low < high) {
            const indexed = runIndex(block);
            for (let r = firstRunAt(indexed, low); r < block.runs.length; r++) {
                const start = indexed.starts[r], end = indexed.starts[r + 1];
                if (start >= high) break;
                if (end > low) pieces.push(block.runs[r].text.slice(Math.max(0, low - start), Math.min(end - start, high - start)));
            }
        }
        if (index < last.index) pieces.push('\n');
    }
    return pieces.join('');
}
export function projectionText(text: RichText): string {
    return text.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
}
