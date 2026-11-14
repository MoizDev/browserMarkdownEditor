import { MAX_TEXT_BLOCKS } from '../model/textLimits';
import type { Block, BlockCarrier, RichFragment, Run } from './richText';
import { validateRichFragmentCooperative } from './richTransaction';
import type { PlainTextOptions } from './plainText';

export interface FragmentSnapshotOptions extends PlainTextOptions {
    /** The capture owner can reject a source revision which changed across a yield. */
    readonly current?: () => boolean;
}

function check(options: FragmentSnapshotOptions): void {
    options.signal?.throwIfAborted();
    if (options.current && !options.current()) throw new DOMException('Rich fragment source changed', 'AbortError');
}
function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Snapshot a rich fragment for an async paste/import before crossing a yield.
 * Every retained object is a fresh frozen object; opaque JSON strings are not
 * parsed, concatenated, or shared through positional carrier identities.
 */
export async function snapshotRichFragmentCooperative(fragment: RichFragment, options: FragmentSnapshotOptions): Promise<RichFragment> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid rich fragment snapshot time slice');
    check(options);
    if (!object(fragment) || !Array.isArray(fragment.blocks) || !fragment.blocks.length || fragment.blocks.length > MAX_TEXT_BLOCKS)
        throw new RangeError('Invalid rich fragment blocks');
    const blocks: Block[] = [];
    let visited = 0, started = performance.now();
    const cooperate = async () => {
        check(options);
        await options.cooperate();
        check(options);
        started = performance.now();
    };
    const due = () => (++visited & 255) === 0 && performance.now() - started >= budget;
    const checkArray = async (value: readonly unknown[]) => {
        // Copying a JSON array must not silently discard extra enumerable properties.
        for (const key in value) {
            const index = Number(key);
            if (!Object.hasOwn(value, key) || !Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length)
                throw new RangeError('Invalid rich fragment array');
            if (due()) await cooperate();
        }
    };
    await checkArray(fragment.blocks);
    for (const source of fragment.blocks) {
        if (!object(source) || !Array.isArray(source.runs) || !source.runs.length
            || (source.carriers !== undefined && !Array.isArray(source.carriers))) throw new RangeError('Invalid rich fragment block');
        await checkArray(source.runs);
        if (source.carriers !== undefined) await checkArray(source.carriers);
        const runs: Run[] = [];
        for (const sourceRun of source.runs) {
            if (!object(sourceRun) || !object(sourceRun.marks)) throw new RangeError('Invalid rich fragment run');
            const marks = Object.freeze({ ...sourceRun.marks });
            runs.push(Object.freeze({ ...sourceRun, marks }) as unknown as Run);
            if (due()) await cooperate();
        }
        const carriers: BlockCarrier[] = [];
        if (source.carriers !== undefined) for (const carrier of source.carriers) {
            if (!object(carrier)) throw new RangeError('Invalid rich block carrier');
            carriers.push(Object.freeze({ ...carrier }) as unknown as BlockCarrier);
            if (due()) await cooperate();
        }
        const copy = { ...source, runs: Object.freeze(runs),
            ...(source.carriers !== undefined ? { carriers: Object.freeze(carriers) } : {}) };
        blocks.push(Object.freeze(copy) as unknown as Block);
        if (due()) await cooperate();
    }
    const result: RichFragment = Object.freeze({ ...fragment, blocks: Object.freeze(blocks) });
    await validateRichFragmentCooperative(result, { ...options, cooperate });
    check(options);
    return result;
}
