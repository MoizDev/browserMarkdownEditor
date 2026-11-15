import { parseJsonIncremental } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import { SECURITY_LIMITS } from '../security/limits';
import { snapshotRichFragmentCooperative, type FragmentSnapshotOptions } from './fragmentSnapshot';
import { validateRichFragmentCooperative } from './richTransaction';
import type { Block, BlockCarrier, RichFragment, Run } from './richText';

export interface RichFragmentAdmissionOptions extends FragmentSnapshotOptions {
    /** Total input UTF-16 units across opaque occurrences, not distinct string values. */
    readonly maxOpaqueUnits?: number;
}
interface ParsedRaw { readonly kind: string; readonly raw: RawJson }

/**
 * Admit an untrusted, data-only fragment without trusting a TypeScript RawJson
 * assertion. Each unknown value is lexically validated and reader-branded;
 * separate tail/mark occurrences remain separate even when their bytes match.
 */
export async function admitRichFragmentCooperative(input: RichFragment, options: RichFragmentAdmissionOptions): Promise<RichFragment> {
    const budget = options.sliceMilliseconds ?? 3, max = options.maxOpaqueUnits ?? SECURITY_LIMITS.recordBytes;
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isSafeInteger(max) || max < 0 || max > SECURITY_LIMITS.recordBytes)
        throw new RangeError('Invalid rich fragment admission limits');
    const check = () => {
        options.signal?.throwIfAborted();
        if (options.current && !options.current()) throw new DOMException('Rich fragment source changed', 'AbortError');
    };
    let started = performance.now(), opaqueUnits = 0, visited = 0;
    const cooperate = async () => {
        check();
        if (performance.now() - started >= budget) {
            await options.cooperate();
            check(); started = performance.now();
        }
    };
    const snapshot = await snapshotRichFragmentCooperative(input, { ...options, cooperate });
    const parsed = new Map<string, ParsedRaw>();
    const admit = async (value: RawJson, array: boolean): Promise<RawJson> => {
        check();
        if (value.length > max - opaqueUnits) throw new RangeError('Rich fragment opaque data exceeds admission limit');
        opaqueUnits += value.length;
        let result = parsed.get(value);
        if (!result) {
            const span = await parseJsonIncremental(value, cooperate);
            result = { kind: span.kind, raw: await span.rawIncremental(cooperate) };
            parsed.set(value, result);
        }
        if (array && result.kind !== 'array') throw new TypeError('Rich tuple tail must be a JSON array');
        return result.raw;
    };
    const blocks: Block[] = [];
    for (const block of snapshot.blocks) {
        const runs: Run[] = [];
        for (const run of block.runs) {
            const marks = run.marks.x === undefined ? run.marks : Object.freeze({ ...run.marks, x: await admit(run.marks.x, false) });
            const tail = run.tail === undefined ? undefined : await admit(run.tail, true);
            runs.push(Object.freeze({ ...run, marks, ...(tail !== undefined ? { tail } : {}) }));
            if ((++visited & 255) === 0) await cooperate();
        }
        const carriers: BlockCarrier[] = [];
        for (const carrier of block.carriers ?? []) {
            carriers.push(Object.freeze({ ...carrier, tail: await admit(carrier.tail, true) }));
            if ((++visited & 255) === 0) await cooperate();
        }
        const tail = block.tail === undefined ? undefined : await admit(block.tail, true);
        blocks.push(Object.freeze({ ...block, runs: Object.freeze(runs),
            ...(tail !== undefined ? { tail } : {}), ...(block.carriers !== undefined ? { carriers: Object.freeze(carriers) } : {}) }));
        if ((++visited & 255) === 0) await cooperate();
    }
    const output: RichFragment = Object.freeze({ blocks: Object.freeze(blocks) });
    await validateRichFragmentCooperative(output, { ...options, cooperate });
    check();
    return output;
}
