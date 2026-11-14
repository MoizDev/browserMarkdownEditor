import { TextBoundaries, type BoundaryDirection } from '../boundaries';
import type { RichText } from '../richText';
import type { EditSelection } from './host';

/** Pane-owned cache; immutable blocks can be shared across document revisions. */
export class RichWordNavigation {
    private readonly boundaries = new TextBoundaries();

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
    clear(): void { this.boundaries.clear(); }
}
