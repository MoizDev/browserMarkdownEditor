import type { RawJson } from '../model/json';

// text.md §4.1: immutable values; UTF-16 offsets refer to the plain-text projection.
export interface RichText { readonly blocks: readonly Block[] }
export type RichFragment = RichText;

export interface Block {
    readonly kind: 'p' | 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    readonly level: number;
    readonly start?: number;
    readonly dir: 'auto' | 'ltr' | 'rtl';
    readonly runs: readonly Run[];
    readonly tail?: RawJson; // R-W19/R-W21: JSON ARRAY of trailing tuple elements; writer splices its interior.
}

export interface Run {
    readonly text: string;
    readonly marks: Marks;
    readonly tail?: RawJson; // R-W19/R-W21: JSON ARRAY of trailing tuple elements; TX-2 finalizes editing semantics.
}

export interface Marks {
    readonly b?: true;
    readonly i?: true;
    readonly u?: true;
    readonly s?: true;
    readonly code?: true;
    readonly hl?: true;
    readonly link?: string;
    readonly x?: RawJson; // R-W25: unknown marks use the same opaque preservation channel.
}
