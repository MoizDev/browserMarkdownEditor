import type { JsonValue, RawJson } from '../model/json';

// text.md §4.1: immutable values; UTF-16 offsets refer to the plain-text projection.
export interface RichText { readonly blocks: readonly Block[] }
export type RichFragment = RichText;

export interface Block {
    readonly kind: 'p' | 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    readonly level: number;
    readonly start?: number;
    readonly dir: 'auto' | 'ltr' | 'rtl';
    readonly runs: readonly Run[];
    readonly tail?: RawJson; // R-W19: unknown tuple elements, kept by the native reader.
}

export interface Run {
    readonly text: string;
    readonly marks: Marks;
    readonly tail?: RawJson; // R-W19: unknown tuple elements/marks; TX-2 finalizes editing semantics.
}

export interface Marks {
    readonly b?: true;
    readonly i?: true;
    readonly u?: true;
    readonly s?: true;
    readonly code?: true;
    readonly hl?: true;
    readonly link?: string;
    readonly x?: JsonValue;
}
