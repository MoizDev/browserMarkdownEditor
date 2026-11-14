import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { SECURITY_LIMITS } from '../security/limits';
import { textBoundaries } from './boundaries';
import { deriveRichTextChange, deriveRichTextChangeCooperative } from './richDiff';
import { ensureProjectionSteps, projectionLength } from './projection';
import { mapTextSelectionTo, normalizeTextSelection, type TextAffinity, type TextSpliceMap } from './rangeMap';
import { sliceRichText, sliceRichTextCooperative, spliceRichText, spliceRichTextCooperative, type Block, type RichFragment, type RichText } from './richText';
import type { RichSelection } from './rich';
import type { PlainTextOptions } from './plainText';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';
import type { FragmentSnapshotOptions } from './fragmentSnapshot';

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
const fragmentKeys = new Set(['blocks']);
const blockKeys = new Set(['kind', 'level', 'dir', 'start', 'runs', 'tail', 'carriers']);
const runKeys = new Set(['text', 'marks', 'tail']);
const carrierKeys = new Set(['from', 'to', 'kind', 'level', 'dir', 'start', 'tail']);
const validFragments = new WeakSet<RichFragment>();

function closed(value: unknown, keys: ReadonlySet<string>): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) return false;
    for (const key in value) if (!Object.hasOwn(value, key) || !keys.has(key)) return false;
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && !('value' in descriptor)) return false;
    }
    return true;
}
function field(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function* array(value: unknown): Generator<void, readonly unknown[]> {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length
        || value.length > 1_000_000) throw new RangeError('Invalid rich fragment array');
    let count = 0;
    for (const key in value) {
        const index = Number(key), descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(value, key) || !Number.isSafeInteger(index) || index < 0 || String(index) !== key
            || index >= value.length || !descriptor || !('value' in descriptor)) throw new RangeError('Invalid rich fragment array');
        if ((++count & 255) === 0) yield;
    }
    return value;
}
function element(value: readonly unknown[], index: number): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new RangeError('Invalid rich fragment array entry');
    return descriptor.value;
}

function* rawArray(value: unknown): Generator<void, boolean> {
    if (typeof value !== 'string' || value.length > SECURITY_LIMITS.recordBytes) return false;
    let first = 0, last = value.length - 1, work = 0;
    const white = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
    while (first <= last && white(value.charCodeAt(first))) { first++; if ((++work & 4095) === 0) yield; }
    while (last >= first && white(value.charCodeAt(last))) { last--; if ((++work & 4095) === 0) yield; }
    return value[first] === '[' && value[last] === ']';
}
function link(value: unknown): boolean {
    if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) return false;
    try {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password && (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:');
    } catch { return false; }
}
function* plainRun(value: string): Generator<void, boolean> {
    let checkpoint = 4096;
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit === 10) return false;
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            index++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
        if (index >= checkpoint) { checkpoint = index + 4096; yield; }
    }
    return true;
}
function attributes(value: object): boolean {
    const kind = field(value, 'kind'), level = field(value, 'level'), dir = field(value, 'dir'), start = field(value, 'start');
    return typeof kind === 'string' && kinds.has(kind as Block['kind']) && typeof level === 'number'
        && Number.isInteger(level) && level >= 0 && level <= 7 && (kind !== 'p' || level === 0)
        && (dir === 'auto' || dir === 'ltr' || dir === 'rtl')
        && (start === undefined || (kind === 'ol' && typeof start === 'number' && Number.isFinite(start)));
}

function* validationSteps(fragment: RichFragment): Generator<void, void> {
    if (fragment && typeof fragment === 'object' && validFragments.has(fragment)) return;
    if (!closed(fragment, fragmentKeys)) throw new RangeError('Invalid rich fragment');
    const blocks = yield* array(field(fragment, 'blocks'));
    if (!blocks.length || blocks.length > MAX_TEXT_BLOCKS) throw new RangeError('Invalid rich fragment blocks');
    let length = blocks.length - 1, visited = 0;
    let immutable = Object.isFrozen(fragment) && Object.isFrozen(blocks);
    for (let b = 0; b < blocks.length; b++) {
        if ((++visited & 255) === 0) yield;
        const block = element(blocks, b);
        if (!closed(block, blockKeys)) throw new RangeError('Invalid rich fragment block');
        const blockObject = block as object, tail = field(blockObject, 'tail'), carrierValue = field(blockObject, 'carriers');
        if (!attributes(blockObject) || (tail !== undefined && !(yield* rawArray(tail)))) throw new RangeError('Invalid rich fragment block');
        const runs = yield* array(field(blockObject, 'runs'));
        if (!runs.length) throw new RangeError('Invalid rich fragment runs');
        const carriers = carrierValue === undefined ? undefined : (yield* array(carrierValue));
        immutable &&= Object.isFrozen(block) && Object.isFrozen(runs) && (carriers === undefined || Object.isFrozen(carriers));
        let blockLength = 0;
        for (let r = 0; r < runs.length; r++) {
            if ((++visited & 255) === 0) yield;
            const run = element(runs, r);
            if (!closed(run, runKeys)) throw new RangeError('Invalid rich fragment run');
            const runObject = run as object, text = field(runObject, 'text'), marks = field(runObject, 'marks'), runTail = field(runObject, 'tail');
            if (typeof text !== 'string' || !closed(marks, markKeys) || (runTail !== undefined && !(yield* rawArray(runTail)))
                || !(yield* plainRun(text))) throw new RangeError('Invalid rich fragment run');
            const marksObject = marks as object;
            immutable &&= Object.isFrozen(run) && Object.isFrozen(marks);
            for (const flag of flags) {
                const mark = field(marksObject, flag);
                if (mark !== undefined && mark !== true) throw new RangeError('Invalid rich fragment mark');
            }
            const url = field(marksObject, 'link'), extra = field(marksObject, 'x');
            if (url !== undefined && !link(url)) throw new RangeError('Invalid rich fragment link');
            if (extra !== undefined && (typeof extra !== 'string' || extra.length > SECURITY_LIMITS.recordBytes)) throw new RangeError('Invalid rich opaque mark');
            blockLength += text.length; length += text.length;
            if (length > MAX_TEXT_LENGTH) throw new RangeError('Rich fragment exceeds text limit');
        }
        for (let c = 0; c < (carriers?.length ?? 0); c++) {
            if ((++visited & 255) === 0) yield;
            const carrier = element(carriers!, c);
            if (!closed(carrier, carrierKeys)) throw new RangeError('Invalid rich block carrier');
            const data = carrier as object, from = field(data, 'from'), to = field(data, 'to');
            immutable &&= Object.isFrozen(carrier);
            if (!attributes(data) || !(yield* rawArray(field(data, 'tail'))) || typeof from !== 'number' || typeof to !== 'number'
                || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > blockLength)
                throw new RangeError('Invalid rich block carrier');
        }
    }
    if (immutable) validFragments.add(fragment);
}

/** Validate only the incoming immutable fragment, never rescan the whole document on each edit. */
export function validateRichFragment(fragment: RichFragment): void {
    finishTextSteps(validationSteps(fragment));
}

/** Caller owns immutability across yields; only deeply frozen fragments are cached for later apply. */
export function validateRichFragmentCooperative(fragment: RichFragment, options: PlainTextOptions): Promise<void> {
    return finishTextStepsCooperative(validationSteps(fragment), options);
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

/** Build a complete multi-op result privately, fencing the source after every scheduler yield. */
export async function applyRichTransactionCooperative(initial: RichText, operations: readonly RichSpliceOperation[], selection: RichSelection,
    options: FragmentSnapshotOptions, affinity: TextAffinity = 'after'): Promise<RichTransactionResult> {
    if (operations.length > 10_000) throw new RangeError('Rich transaction has too many operations');
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid rich transaction time slice');
    const check = () => {
        options.signal?.throwIfAborted();
        if (options.current && !options.current()) throw new DOMException('Rich transaction source changed', 'AbortError');
    };
    const fenced: PlainTextOptions = { ...options, cooperate: async () => { check(); await options.cooperate(); check(); } };
    check();
    await finishTextStepsCooperative(ensureProjectionSteps(initial), fenced);
    let text = initial, current = normalizeTextSelection(initial, selection, affinity), started = performance.now();
    const inverseSelection = current, inverses: RichSpliceOperation[] = [], maps: (TextSpliceMap | null)[] = [];
    for (const operation of operations) {
        check();
        if (operation.to < operation.from || !(await textBoundaries.isBoundaryCooperative(text, operation.from, fenced))
            || !(await textBoundaries.isBoundaryCooperative(text, operation.to, fenced))) throw new RangeError('Rich splice must use grapheme boundaries');
        await validateRichFragmentCooperative(operation.insert, fenced);
        const old = await sliceRichTextCooperative(text, operation.from, operation.to, fenced, true);
        const local = await deriveRichTextChangeCooperative(old, operation.insert, fenced);
        const map: TextSpliceMap | null = local ? { from: operation.from + local.from, to: operation.from + local.oldTo,
            insertedLength: local.newTo - local.from } : null;
        const result = await spliceRichTextCooperative(text, operation.from, operation.to, operation.insert, fenced, operation.wholeBlocks === true);
        current = map ? mapTextSelectionTo(current, map, result.text, affinity) : normalizeTextSelection(result.text, current, affinity);
        maps.push(map); inverses.push(result.inverse); text = result.text;
        if (performance.now() - started >= budget) { await fenced.cooperate(); started = performance.now(); }
    }
    check(); inverses.reverse();
    return { text, selection: current, inverse: inverses, inverseSelection, maps };
}

/** Current length is available without joining the transaction's projected text. */
export function richTransactionLength(result: RichTransactionResult): number { return projectionLength(result.text); }
