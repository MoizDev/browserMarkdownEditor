import { Compartment, Facet } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

export interface ReadingEmphasisOptions { enabled: boolean; mode: 'read' | 'edit'; locale: string }
const OFF: ReadingEmphasisOptions = Object.freeze({ enabled: false, mode: 'edit', locale: '' });
export const readingEmphasisFacet = Facet.define<ReadingEmphasisOptions, ReadingEmphasisOptions>({
    combine: values => values.length ? values[values.length - 1] : OFF,
    compare: (a, b) => a.enabled === b.enabled && a.mode === b.mode && a.locale === b.locale,
});
export const readingEmphasisCompartment = new Compartment();
export function readingEmphasisOptions(options: ReadingEmphasisOptions): Extension {
    return readingEmphasisFacet.of(Object.freeze({ ...options }));
}
