import type { FrameBudget } from '../../platform/render/types';

/** The budget one layer prepares under: the frame's own budget with one unit of work always admitted. A frame's prepare
 * slice can be zero (input and presentation take the whole target), and then no layer advances: nothing wakes a stalled
 * build but the next frame, which has no time either. One unit is one bounded step, so a frame costs one step more.
 * Each consumer wraps its own budget: the admitted unit is that consumer's, so a shared one would starve the others. */
export function withFirstUnit(budget: FrameBudget): FrameBudget {
    let admitted = false;
    // A plain copy, never a prototype wrapper: a nested `{ ...budget }` keeps only own fields, and an inherited frameId
    // spread away as undefined left each dense tile's item adapter stepping once and never again (frameId guard).
    return { ...budget, shouldYield: (): boolean => {
        if (!admitted) { admitted = true; return false; }
        return budget.shouldYield();
    } };
}
