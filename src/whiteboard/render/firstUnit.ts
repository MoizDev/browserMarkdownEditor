import type { FrameBudget } from '../../platform/render/types';

export function withFirstUnit(budget: FrameBudget): FrameBudget {
    let admitted = false;
    // A plain copy, never a prototype wrapper: a nested `{ ...budget }` keeps only own fields, and an inherited frameId
    // spread away as undefined left each dense tile's item adapter stepping once and never again (frameId guard).
    return { ...budget, shouldYield: (): boolean => {
        if (!admitted) { admitted = true; return false; }
        return budget.shouldYield();
    } };
}
