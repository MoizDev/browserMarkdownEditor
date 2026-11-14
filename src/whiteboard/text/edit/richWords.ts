import { TextBoundaries, type BoundaryDirection } from '../boundaries';
import { yieldToHost } from '../cooperative';
import type { RichText } from '../richText';
import type { EditSelection } from './host';

/** Pane-owned cache; immutable blocks can be shared across document revisions. */
export class RichWordNavigation {
    private readonly boundaries = new TextBoundaries();
    private priming: AbortController | undefined;

    /** Warms the wordless-block proofs of a value opened for editing, in host-yielding slices. Advisory only:
     * word motion computes any missing proof itself, so a warm that fails or is abandoned is never visible. */
    prime(text: RichText): void {
        this.priming?.abort();
        const priming = this.priming = new AbortController();
        this.boundaries.primeWords(text, { signal: priming.signal, cooperate: yieldToHost }).catch(() => { /* advisory */ });
    }

    selectWord(text: RichText, offset: number): EditSelection {
        return this.boundaries.selectWord(text, offset);
    }
    selectBlock(text: RichText, offset: number): EditSelection {
        return this.boundaries.selectBlock(text, offset);
    }
    adjacent(text: RichText, offset: number, direction: BoundaryDirection): number {
        return this.boundaries.adjacent(text, offset, direction);
    }
    boundary(text: RichText, offset: number, direction: BoundaryDirection): number {
        return this.boundaries.word(text, offset, direction);
    }
    clear(): void { this.priming?.abort(); this.priming = undefined; this.boundaries.clear(); }
}
