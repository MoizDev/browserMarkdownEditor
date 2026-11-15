import { MAX_TEXT_BLOCKS } from '../model/textLimits';
import type { Block, BlockCarrier, RichFragment, Run } from './richText';
import { validateRichFragmentCooperative } from './richTransaction';
import type { PlainTextOptions } from './plainText';

export interface FragmentSnapshotOptions extends PlainTextOptions {
    /** The capture owner can reject a source revision which changed across a yield. */
    readonly current?: () => boolean;
}

const MAX_COMPONENTS = 1_000_000;
function check(options: FragmentSnapshotOptions): void {
    options.signal?.throwIfAborted();
    if (options.current && !options.current()) throw new DOMException('Rich fragment source changed', 'AbortError');
}
function record(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Snapshot a rich fragment before crossing an asynchronous clipboard/import seam.
 * No source getter is invoked; every published container is newly frozen and
 * opaque JSON strings remain independent values, not concatenated carriers.
 */
export async function snapshotRichFragmentCooperative(fragment: RichFragment, options: FragmentSnapshotOptions): Promise<RichFragment> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid rich fragment snapshot time slice');
    check(options);
    let visited = 0, started = performance.now();
    const cooperate = async () => {
        check(options);
        await options.cooperate();
        check(options);
        started = performance.now();
    };
    const due = () => {
        if (++visited > MAX_COMPONENTS) throw new RangeError('Rich fragment exceeds structural limits');
        return (visited & 255) === 0 && performance.now() - started >= budget;
    };
    const copyRecord = async (source: unknown): Promise<Record<string, unknown>> => {
        if (!record(source) || Object.getOwnPropertySymbols(source).length) throw new TypeError('Rich fragment must contain data-only objects');
        const result: Record<string, unknown> = Object.create(null);
        for (const key in source) {
            if (!Object.hasOwn(source, key)) throw new TypeError('Rich fragment has inherited fields');
            const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
            if (!('value' in descriptor)) throw new TypeError('Rich fragment contains an accessor');
            result[key] = descriptor.value;
            if (due()) await cooperate();
        }
        return result;
    };
    const checkArray = async (source: unknown): Promise<readonly unknown[]> => {
        if (!Array.isArray(source) || Object.getOwnPropertySymbols(source).length) throw new TypeError('Invalid rich fragment array');
        for (const key in source) {
            if (!Object.hasOwn(source, key)) throw new TypeError('Rich fragment array has inherited fields');
            const index = Number(key), descriptor = Object.getOwnPropertyDescriptor(source, key)!;
            if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= source.length || !('value' in descriptor))
                throw new TypeError('Rich fragment array has extra fields or accessors');
            if (due()) await cooperate();
        }
        return source;
    };
    const arrayItem = (source: readonly unknown[], index: number): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Rich fragment array has a hole or accessor');
        return descriptor.value;
    };

    const root = await copyRecord(fragment), sourceBlocks = await checkArray(root.blocks);
    if (!sourceBlocks.length || sourceBlocks.length > MAX_TEXT_BLOCKS) throw new RangeError('Invalid rich fragment blocks');
    const blocks: Block[] = [];
    for (let b = 0; b < sourceBlocks.length; b++) {
        const source = await copyRecord(arrayItem(sourceBlocks, b));
        const sourceRuns = await checkArray(source.runs);
        if (!sourceRuns.length) throw new RangeError('Invalid rich fragment runs');
        const runs: Run[] = [];
        for (let r = 0; r < sourceRuns.length; r++) {
            const run = await copyRecord(arrayItem(sourceRuns, r));
            const marks = Object.freeze(await copyRecord(run.marks));
            runs.push(Object.freeze({ ...run, marks }) as unknown as Run);
            if (due()) await cooperate();
        }
        let carriers: readonly BlockCarrier[] | undefined;
        if (source.carriers !== undefined) {
            const input = await checkArray(source.carriers), output: BlockCarrier[] = [];
            for (let c = 0; c < input.length; c++) {
                output.push(Object.freeze(await copyRecord(arrayItem(input, c))) as unknown as BlockCarrier);
                if (due()) await cooperate();
            }
            carriers = Object.freeze(output);
        }
        const copy = { ...source, runs: Object.freeze(runs), ...(carriers ? { carriers } : {}) };
        blocks.push(Object.freeze(copy) as unknown as Block);
        if (due()) await cooperate();
    }
    const result: RichFragment = Object.freeze({ ...root, blocks: Object.freeze(blocks) });
    await validateRichFragmentCooperative(result, { ...options, cooperate });
    check(options);
    return result;
}
