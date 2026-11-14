import type { BoardDocInput } from './doc';
import type { RawJson } from './json';
import type { MediaId } from './media';
import { extRawValues, hostRawValues, nodeRawValues, preservedRawValues, scanRawMediaIncremental } from './rawMedia';

// Provenance: document-model §9.3 and R-W25/R-W40; existing raw-carrier and
// incremental scanner contracts. Independent glue, no third-party source.
export async function recountLoadMedia(input: BoardDocInput, cooperate?: () => Promise<void>,
    signal?: AbortSignal): Promise<ReadonlyMap<MediaId, number>> {
    const counts = new Map<MediaId, number>();
    let steps = 0;
    const check = () => {
        if (signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    const tick = async () => {
        check();
        await cooperate?.();
        check();
    };
    const add = (id: MediaId) => {
        const count = counts.get(id) ?? 0;
        if (count === Number.MAX_SAFE_INTEGER) throw new RangeError('Preserved media reference count exceeds safe integer');
        counts.set(id, count + 1);
    };
    const scan = async (values: Iterable<RawJson | null>, self?: MediaId) => {
        for (const raw of values) {
            if ((steps++ & 255) === 0) await tick();
            if (raw !== null) {
                await scanRawMediaIncremental(raw, self === undefined ? add : id => { if (id !== self) add(id); }, tick);
                check();
            }
        }
    };
    await tick();
    await scan(preservedRawValues(input.preserved)); check();
    await scan(hostRawValues(input.host)); check();
    await scan(extRawValues(input.ui.ext)); check();
    await scan(extRawValues(input.view.ext)); check();
    for (const sheet of input.sheets) {
        if ((steps++ & 255) === 0) await tick();
        await scan(extRawValues(sheet.ext)); check();
    }
    for (const entry of input.media ?? []) {
        if ((steps++ & 255) === 0) await tick();
        await scan(extRawValues(entry.ext), entry.id); check();
    }
    for (const node of input.nodes ?? []) {
        if ((steps++ & 255) === 0) await tick();
        await scan(nodeRawValues(node)); check();
    }
    check();
    return counts;
}
