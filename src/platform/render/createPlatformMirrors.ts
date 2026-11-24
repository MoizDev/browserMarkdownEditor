import { MirrorSet } from './mirrorSet';
import type { MirrorSetOptions } from './mirrorSet';
import { getPlatformRuntime } from './platformRuntime';

export interface PlatformSessionSlots {
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void): void;
}

export type PlatformMirrorOptions<T extends object> = Omit<MirrorSetOptions<T>, 'governor' | 'createdAt'> & {
    readonly session: PlatformSessionSlots;
    readonly createdAt?: number;
};

const mirrorsSlot = Symbol('platform session mirrors');

/** Call only from the lazy engine/session chunk. The core retains an opaque keyed slot and runs
 * its disposer after the session closing barrier or replacement, never on a pane's React cleanup.
 */
export function createPlatformMirrors<T extends object>(options: PlatformMirrorOptions<T>): MirrorSet<T> {
    const existing = options.session.getSlot<MirrorSet<T>>(mirrorsSlot);
    if (existing) {
        const owner = existing.owner;
        if (owner.vaultEpoch !== options.owner.vaultEpoch || owner.documentId !== options.owner.documentId || owner.session !== options.owner.session) {
            throw new Error('The renderer slot belongs to a different session');
        }
        return existing;
    }
    const { session, ...settings } = options;
    const mirrors = new MirrorSet({ ...settings, createdAt: options.createdAt ?? performance.now(), governor: getPlatformRuntime().governor });
    try { session.setSlot(mirrorsSlot, mirrors, value => value.releaseSession()); }
    catch (error) { mirrors.releaseSession(); throw error; }
    return mirrors;
}
