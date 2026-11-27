import { SidebarLeft } from './icons';
import { AgentUpdateDot } from './agentUpdateIndicator';
import { agentUpdateHint, useAgentUpdateNotice } from './agentUpdateHint';

export function SidebarRailExpand({ onExpand }: { onExpand: () => void }) {
    const hint = agentUpdateHint(useAgentUpdateNotice());
    const label = `Expand sidebar (⌘\\)${hint ? ` — ${hint}` : ''}`;
    return (
        <button
            className="sidebar-rail-btn"
            onClick={onExpand}
            data-tooltip={label}
            data-tooltip-position="right"
            aria-label={hint ? `Expand sidebar — ${hint}` : 'Expand sidebar'}
        >
            <SidebarLeft size={18} strokeWidth={1.75} />
            {hint && <AgentUpdateDot />}
        </button>
    );
}
