// Consecutive tool steps, in one hairline box with a hairline between rows.
//
// Three or more fold: a head row "Worked through N steps ›" and only the LAST
// TWO rows — the newest work is what someone watching a run wants, and a
// research turn that read twenty notes should not push the answer two screens
// down. Opening the head unfolds the whole stack (and the head goes: there is
// nothing left behind it).

import { memo, useState } from 'react';
import { ChevronRight } from './ui/icons';
import { ToolStep } from './ToolCallCard';
import type { ToolItem } from './toolSteps';

/** How many steps a stack holds before it folds, and how many stay visible. */
const FOLD_AT = 3;
const VISIBLE_WHEN_FOLDED = 2;

function StepStackImpl({ items }: { items: ToolItem[] }) {
    const [unfolded, setUnfolded] = useState(false);
    const folded = items.length >= FOLD_AT && !unfolded;
    const shown = folded ? items.slice(-VISIBLE_WHEN_FOLDED) : items;
    return (
        <div className={'va-steps' + (folded ? ' is-folded' : '')}>
            {folded && (
                <div className="va-step va-step-head">
                    <button type="button" className="va-steprow" aria-expanded={false} onClick={() => setUnfolded(true)}>
                        <span className="va-step-verb">Worked through {items.length} steps</span>
                        <ChevronRight className="va-step-chev" aria-hidden="true" />
                    </button>
                </div>
            )}
            {shown.map(item => <ToolStep key={item.id} item={item} />)}
        </div>
    );
}

/** The list hands over a fresh array on every render; the steps inside are
 *  replaced (never mutated) when they change, so equal members = no change.
 *  Without this every streamed token re-rendered every stack above it. */
export const StepStack = memo(StepStackImpl, (a, b) =>
    a.items.length === b.items.length && a.items.every((item, i) => item === b.items[i]));
