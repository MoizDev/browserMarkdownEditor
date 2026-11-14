import type { IndexSession } from '../../utils/vaultIndex/types';

let lastSession = 0;

/** A re-open of the same vault is still a different activation. */
export function newIndexSession(vaultId: string): IndexSession {
    return { vaultId, sessionNo: ++lastSession };
}
