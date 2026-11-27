import type { IndexSession } from '../../utils/vaultIndex/types';

let lastSession = 0;

export function newIndexSession(vaultId: string): IndexSession {
    return { vaultId, sessionNo: ++lastSession };
}
