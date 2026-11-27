import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

export function useFloatingSlot(isVisible: boolean, index: number, left: number, width: number): CSSProperties {
    const [shown, setShown] = useState({ index, left, width });
    useLayoutEffect(() => {
        if (isVisible) setShown(prev =>
            prev.index === index && prev.left === left && prev.width === width
                ? prev
                : { index, left, width });
    }, [isVisible, index, left, width]);
    const slot = isVisible ? { index, left, width } : shown;
    return useMemo(() => (isVisible
        ? {
            left: `calc(var(--pane-x-${slot.index}) * 1%)`,
            width: `calc(var(--pane-w-${slot.index}) * 1%)`,
            right: 'auto' as const,
        }
        : { left: `${slot.left}%`, width: `${slot.width}%`, right: 'auto' as const }
    ), [isVisible, slot.index, slot.left, slot.width]);
}

export function useActivated(isVisible: boolean): boolean {
    const [activated, setActivated] = useState(isVisible);
    useEffect(() => { if (isVisible) setActivated(true); }, [isVisible]);
    return activated;
}
