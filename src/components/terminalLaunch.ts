import { loadChunk } from '../platform/chunkLoad';

export function connectHelperForTerminal(): void {
    loadChunk(() => import('../utils/agentBridge')).then(({ agentBridge }) => {
        const s = agentBridge.getState();
        if (s.status === 'idle' || (s.status === 'failed' && s.retryAt == null)) void agentBridge.connect();
    }).catch(() => { /* the dock's own gate reports problems */ });
}
