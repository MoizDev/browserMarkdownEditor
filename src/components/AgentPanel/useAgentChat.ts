import { useSyncExternalStore } from 'react';
import { agentBridge } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';
import type { AgentId } from '../../../shared/vaultAgentProtocol';

export function useBridgeState(): BridgeState {
    return useSyncExternalStore(agentBridge.subscribeState, agentBridge.getState);
}

export function useChatState(): ChatStoreState {
    return useSyncExternalStore(chatStore.subscribe, chatStore.getState);
}

export function effortLabel(effort: string): string {
    const known: Record<string, string> = {
        minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
        xhigh: 'Extra high', max: 'Max', none: 'None',
    };
    return known[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export type AgentHealth = 'ready' | 'logged-out' | 'unknown-login' | 'missing' | 'checking';

export function agentHealth(state: ChatStoreState, agent: AgentId): AgentHealth {
    const status = state.agents.find(a => a.agent === agent);
    if (!status) return 'checking';
    if (!status.installed) return 'missing';
    if (status.loggedIn === false) return 'logged-out';
    if (status.loggedIn === null) return 'unknown-login';
    return 'ready';
}

export const HEALTH_CAPTION: Record<AgentHealth, string> = {
    ready: 'Ready',
    'logged-out': 'Not logged in',
    'unknown-login': 'Login not confirmed',
    missing: 'Not installed',
    checking: 'Checking…',
};
