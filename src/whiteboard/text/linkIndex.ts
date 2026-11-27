import type { Block } from './richText';
import { runContaining, runIndex } from './runIndex';
import { WeakIdentityLru } from './weakLru';

export interface LinkRange { readonly from: number; readonly to: number; readonly url: string }
interface Links { readonly ranges: LinkRange[]; bytes: number }
const cache = new WeakIdentityLru<Block, Links>(4 * 1024 * 1024, 128);

export function linkRangeAtBlock(block: Block, offset: number): LinkRange | null {
    const index = runIndex(block);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > index.length) throw new RangeError('Invalid link offset');
    if (!index.length) return null;
    const character = offset ? offset - 1 : 0;
    let links = cache.get(block);
    if (links) {
        let low = 0, high = links.ranges.length;
        while (low < high) {
            const middle = low + ((high - low) >>> 1);
            if (links.ranges[middle].to <= character) low = middle + 1; else high = middle;
        }
        const found = links.ranges[low];
        if (found && found.from <= character) return found;
    }
    const chosen = runContaining(index, character), url = block.runs[chosen].marks.link;
    if (!url) return null;
    let first = chosen, last = chosen;
    while (first > 0 && (!block.runs[first - 1].text.length || block.runs[first - 1].marks.link === url)) first--;
    while (last + 1 < index.count && (!block.runs[last + 1].text.length || block.runs[last + 1].marks.link === url)) last++;
    const found: LinkRange = { from: index.starts[first], to: index.starts[last + 1], url };
    if (!links) links = { ranges: [], bytes: 256 };
    let low = 0, high = links.ranges.length;
    while (low < high) {
        const middle = low + ((high - low) >>> 1);
        if (links.ranges[middle].from < found.from) low = middle + 1; else high = middle;
    }
    links.ranges.splice(low, 0, found);
    links.bytes += 80 + url.length * 2;
    cache.set(block, links, links.bytes);
    return found;
}

export function clearLinkIndexes(): void { cache.clear(); }
