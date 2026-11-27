import { helperReady, type BridgeState } from '../../utils/agentBridge';

export type GateRequirement = 'chat' | 'terminal';

export function gatePasses(bridge: BridgeState, requirement: GateRequirement): boolean {
    return helperReady(bridge) && (requirement === 'chat' || bridge.helper.terminal);
}
