import { useCallback, useMemo, useState } from 'react';

const MAX_BOARD_NOTICES = 4;

export interface BoardNotices {
    readonly list: readonly string[];
    readonly show: (message: string) => void;
    readonly dismiss: (message: string) => void;
    readonly clear: (message: string) => void;
}

export function useBoardNotices(initial: readonly string[] = [], onDismiss?: (message: string) => void): BoardNotices {
    const [list, setList] = useState<readonly string[]>(() => initial.slice(-MAX_BOARD_NOTICES));
    const show = useCallback((message: string) => setList(shown => shown.includes(message) ? shown : [...shown, message].slice(-MAX_BOARD_NOTICES)), []);
    const remove = useCallback((message: string) => setList(shown => shown.includes(message) ? shown.filter(item => item !== message) : shown), []);
    const dismiss = useCallback((message: string) => { remove(message); onDismiss?.(message); }, [remove, onDismiss]);
    return useMemo(() => ({ list, show, dismiss, clear: remove }), [list, show, dismiss, remove]);
}
