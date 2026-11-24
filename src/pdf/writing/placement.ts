import type { Affine, PageGeometry } from '../../platform/types';
import type { InkPackage } from './types';

/** The ink PDF has ordinary bottom-left PDF coordinates; the viewing engine's
 * inverse viewport maps top-left display coordinates into the pristine page.
 * E is its own inverse, so the placement is A × E, not just A. */
export function inkPlacement(geometry: PageGeometry, page: InkPackage['pages'][number]): Affine {
    if (!Number.isSafeInteger(geometry.index) || geometry.index < 0 || geometry.index !== page.sourcePage ||
        !Number.isSafeInteger(page.inkPage) || page.inkPage < 0 || !(page.width > 0) || !(page.height > 0) ||
        page.width !== geometry.width || page.height !== geometry.height || !/^[0-9a-f]{64}$/.test(page.hash)) {
        throw new Error('Ink page does not match its source geometry');
    }
    const a = geometry.toUserSpace;
    if (!Array.isArray(a) || a.length !== 6 || a.some(value => !Number.isFinite(value))) throw new Error('Invalid PDF page mapping');
    const [aa, b, c, d, e, f] = a;
    const result: Affine = [aa, b, -c, -d, c * page.height + e, d * page.height + f];
    if (result.some(value => !Number.isFinite(value))) throw new RangeError('PDF ink placement exceeds the supported range');
    return result;
}

/** Validate source/page uniqueness before any mutable writer session is opened. */
export function inkPlacements(geometry: readonly PageGeometry[], ink: InkPackage): Array<{ sourcePage: number; inkPage: number; matrix: Affine }> {
    if (!ink || ink.schema !== 1 || !(ink.bytes instanceof Uint8Array) || ink.bytes.length === 0 || !Array.isArray(ink.pages)) throw new Error('Invalid ink package');
    const sources = new Set<number>(), emitted = new Set<number>();
    return ink.pages.map(page => {
        if (sources.has(page.sourcePage) || emitted.has(page.inkPage)) throw new Error('Duplicate ink page');
        sources.add(page.sourcePage); emitted.add(page.inkPage);
        const source = geometry[page.sourcePage];
        if (!source) throw new Error('Ink references a missing source page');
        return { sourcePage: page.sourcePage, inkPage: page.inkPage, matrix: inkPlacement(source, page) };
    });
}
