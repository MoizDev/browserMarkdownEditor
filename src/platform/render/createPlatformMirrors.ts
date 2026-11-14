import { MirrorSet } from './mirrorSet';
import type { MirrorSetOptions } from './mirrorSet';
import { getPlatformRuntime } from './platformRuntime';

export type PlatformMirrorOptions<T extends object> = Omit<MirrorSetOptions<T>, 'governor' | 'createdAt'> & {
    readonly createdAt?: number;
};

/** Call from the lazy engine/session factory, never App's initial import graph. Keep this object
 * in the App session's opaque renderer slot; releaseSession is the closing barrier's callback,
 * not a React cleanup. A view only returns its temporary borrow on hide/unmount.
 */
export function createPlatformMirrors<T extends object>(options: PlatformMirrorOptions<T>): MirrorSet<T> {
    return new MirrorSet({ ...options, createdAt: options.createdAt ?? performance.now(), governor: getPlatformRuntime().governor });
}
