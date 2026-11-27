import type { NodeId } from '../model/ids';

export interface DuplicateSourceOrigin { readonly x: number; readonly y: number }

const repeats = new WeakMap<object, { readonly copies: string; readonly sourceOrigin: DuplicateSourceOrigin }>();
const keyOf = (ids: readonly NodeId[]) => [...ids].sort().join(',');

export function rememberDuplicate(session: object, copies: readonly NodeId[], sourceOrigin: DuplicateSourceOrigin): void {
    repeats.set(session, { copies: keyOf(copies), sourceOrigin });
}
export function duplicateRepeatSource(session: object, selected: readonly NodeId[]): DuplicateSourceOrigin | null {
    const repeat = repeats.get(session);
    return repeat && repeat.copies === keyOf(selected) ? repeat.sourceOrigin : null;
}
