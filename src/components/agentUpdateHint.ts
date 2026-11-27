import { useSyncExternalStore } from 'react';
import {
    CONNECTED_ONCE_KEY, getAgentUpdateNotice, subscribeAgentUpdateNotice, type AgentUpdateNotice,
} from '../utils/agentUpdateNotice';
import { loadChunk } from '../platform/chunkLoad';

export function useAgentUpdateNotice(): AgentUpdateNotice {
    return useSyncExternalStore(subscribeAgentUpdateNotice, getAgentUpdateNotice);
}

export function agentUpdateHint(notice: AgentUpdateNotice): string | null {
    if (!notice) return null;
    return notice.kind === 'available' ? `VaultAgent ${notice.version} is available` : `VaultAgent ${notice.version} needs an update`;
}

let scheduled = false;

export function scheduleAgentUpdateCheck(): void {
    if (scheduled) return; // StrictMode runs the mount effect twice
    scheduled = true;
    try {
        if (localStorage.getItem(CONNECTED_ONCE_KEY) !== '1') return;
    } catch {
        return;
    }
    const run = () => {
        loadChunk(() => import('../utils/agentBridge')).then(m => m.agentBridge.checkInBackground()).catch(() => { /* the panel reports problems; a hint does not */ });
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(run, { timeout: 5000 });
    else setTimeout(run, 2000);
}
