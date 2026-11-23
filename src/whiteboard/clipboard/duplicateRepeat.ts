import type { NodeId } from '../model/ids';

export interface DuplicateSourceOrigin { readonly x: number; readonly y: number }

/** The copies the last duplicate left selected, and where the source they copied sat (world units). Cmd+D and an Alt-drag clone
 * both write it, so a Cmd+D after a clone drop repeats the clone's offset. Keyed by the board session, which a vault switch replaces. */
const repeats = new WeakMap<object, { readonly copies: string; readonly sourceOrigin: DuplicateSourceOrigin }>();
const keyOf = (ids: readonly NodeId[]) => [...ids].sort().join(',');

export function rememberDuplicate(session: object, copies: readonly NodeId[], sourceOrigin: DuplicateSourceOrigin): void {
    repeats.set(session, { copies: keyOf(copies), sourceOrigin });
}
/** The origin the selected copies must be measured from to repeat the last duplicate's offset; null unless the selection is those copies. */
export function duplicateRepeatSource(session: object, selected: readonly NodeId[]): DuplicateSourceOrigin | null {
    const repeat = repeats.get(session);
    return repeat && repeat.copies === keyOf(selected) ? repeat.sourceOrigin : null;
}
