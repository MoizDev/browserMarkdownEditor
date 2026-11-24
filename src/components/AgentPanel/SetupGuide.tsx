// The agent panel's setup screens. The connection screens themselves are the
// shared HelperGate (the terminal dock shows the same ones); this file is the
// agent's copy for them, plus the warning above the composer.

import type { ReactNode } from 'react';
import { AGENT_IDS, AGENT_LABELS } from '../../../shared/vaultAgentProtocol';
import type { AgentId, AgentStatus } from '../../../shared/vaultAgentProtocol';
import type { BridgeState } from '../../utils/agentBridge';
import { AGENT_LOGIN_HINTS } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { HelperGate } from '../HelperGate/HelperGate';
import { CommandLine } from './CommandLine';

function LoginLines() {
    return (
        <ul className="agent-logins">
            {AGENT_IDS.map(agent => {
                const hint = AGENT_LOGIN_HINTS[agent];
                return (
                    <li key={agent}>
                        <span className="agent-logins-name">{AGENT_LABELS[agent]}</span>
                        <span className="agent-logins-cmd">
                            {hint.commands.map(c => <CommandLine key={c} command={c} />)}
                            {hint.note && <span className="agent-muted">{hint.note}</span>}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

const LOGIN_STEP = (
    <li>
        <h3>Log in to your agent in a terminal</h3>
        <LoginLines />
    </li>
);

export interface SetupGuideProps {
    os: OsKind;
    arch: CpuArch;
    supported: boolean;
    bridge: BridgeState;
    onConnect: () => void;
    onUpdate: () => void;
}

export function SetupGuide(props: SetupGuideProps) {
    return (
        <HelperGate
            {...props}
            requirement="chat"
            noun="the AI agent"
            title="Set up the AI agent"
            lede={<>
                Chat with Claude Code, Codex or OpenCode about what you're looking at. It runs on this computer
                with your agent's full access, and its edits to this vault land in your editor.
            </>}
            preface={LOGIN_STEP}
        />
    );
}

/** The chosen agent cannot take a message — said above the composer. */
export function AgentWarning({ agent, status, onRecheck }: {
    agent: AgentId;
    status: AgentStatus | null;
    onRecheck: () => void;
}) {
    if (!status) return null;
    const name = AGENT_LABELS[agent];
    let body: ReactNode = null;
    let tone: 'error' | 'warning' = 'error';
    if (!status.installed) {
        body = (
            <>
                <p><b>{name} isn't installed</b> on this computer. Install it in a terminal:</p>
                <CommandLine command={status.installCommand} />
            </>
        );
    } else if (status.loggedIn === false) {
        const hint = AGENT_LOGIN_HINTS[agent];
        body = (
            <>
                <p><b>You're not logged in to {name}.</b> Log in from a terminal on this computer:</p>
                <CommandLine command={status.loginCommand} />
                {status.loginCommand.trim() === 'claude' && hint.note && <span className="agent-muted"> {hint.note}</span>}
            </>
        );
    } else if (status.loggedIn === null) {
        tone = 'warning';
        body = <p>Couldn't confirm you're logged in to {name}. If sending fails, log in from a terminal: <CommandLine command={status.loginCommand} /></p>;
    }
    if (!body) return null;
    return (
        <div className={'agent-warning ' + tone} role="status">
            {body}
            <button type="button" className="agent-link" onClick={onRecheck}>Check again</button>
        </div>
    );
}
