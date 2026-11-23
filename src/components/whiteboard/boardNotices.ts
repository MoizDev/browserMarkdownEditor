import { useCallback, useMemo, useState } from 'react';

/** The most notices a board keeps on screen at once; an older one beyond it gives way to the newest. A board raises a
 * handful at most (a conversion's left-out items, no usable GPU, a refused paste), so this never drops one in practice. */
const MAX_BOARD_NOTICES = 4;

export interface BoardNotices {
    /** Oldest first, newest last: the order they are shown in. */
    readonly list: readonly string[];
    /** Shows a notice beside the others. One already shown stays where it is rather than appearing twice. */
    readonly show: (message: string) => void;
    /** The person puts one away (its Dismiss). */
    readonly dismiss: (message: string) => void;
    /** The source that raised it says it no longer holds: it goes without counting as dismissed. */
    readonly clear: (message: string) => void;
}

/** A board's notices, shown together. A board had ONE slot: the second notice replaced the first, and the replaced one
 * counted as dismissed and never came back (seen: a converted board's "3 items from the old board could not be shown"
 * gone for good under "GPU rendering is unavailable"). `onDismiss` is told only when the person puts one away. */
export function useBoardNotices(initial: readonly string[] = [], onDismiss?: (message: string) => void): BoardNotices {
    const [list, setList] = useState<readonly string[]>(() => initial.slice(-MAX_BOARD_NOTICES));
    const show = useCallback((message: string) => setList(shown => shown.includes(message) ? shown : [...shown, message].slice(-MAX_BOARD_NOTICES)), []);
    const remove = useCallback((message: string) => setList(shown => shown.includes(message) ? shown.filter(item => item !== message) : shown), []);
    const dismiss = useCallback((message: string) => { remove(message); onDismiss?.(message); }, [remove, onDismiss]);
    return useMemo(() => ({ list, show, dismiss, clear: remove }), [list, show, dismiss, remove]);
}
