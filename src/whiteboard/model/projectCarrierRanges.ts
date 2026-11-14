import type { BlockCarrier } from '../text/richText';

export interface ProjectedBlockCarrier { readonly index: number; readonly carrier: BlockCarrier; }

// Both native admission and model repair split embedded newlines. Keep their
// range/anchor mapping identical, including a range covering only a removed break.
export function* projectBlockCarrier(carrier: BlockCarrier, first: number, last: number,
    starts: readonly number[], lengths: readonly number[]): Generator<ProjectedBlockCarrier | null> {
    let low = first, high = last;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (starts[middle] <= carrier.from) low = middle; else high = middle;
    }
    const anchor = low;
    let added = false, work = 0;
    if (carrier.from !== carrier.to) for (let index = low; index < last && starts[index] < carrier.to; index++) {
        const from = Math.max(carrier.from, starts[index]), to = Math.min(carrier.to, starts[index] + lengths[index]);
        if (from < to) {
            yield { index, carrier: { ...carrier, from: from - starts[index], to: to - starts[index] } };
            added = true;
        }
        if ((++work & 255) === 0) yield null;
    }
    if (!added) {
        const offset = Math.min(lengths[anchor], Math.max(0, carrier.from - starts[anchor]));
        yield { index: anchor, carrier: { ...carrier, from: offset, to: offset } };
    }
}
