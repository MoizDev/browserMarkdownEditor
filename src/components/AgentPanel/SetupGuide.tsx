// Every panel screen before the chat: the first-time guide, and one screen
// per way the connection can be missing. Short on purpose — each says what is
// wrong and offers the one or two buttons that fix it.

import type { ReactNode } from 'react';
import { AGENT_IDS, AGENT_LABELS, HELPER_NAME, HELPER_PORTS, MIN_HELPER_VERSION } from '../../../shared/vaultAgentProtocol';
import type { AgentId, AgentStatus } from '../../../shared/vaultAgentProtocol';
import { hasConnectedBefore, type BridgeState } from '../../utils/agentBridge';
import { AGENT_LOGIN_HINTS, installerAsset, openInstallerSteps } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { Orb } from './aicss/Orb';
import { CommandLine } from './CommandLine';

interface PlatformProps {
    os: OsKind;
    arch: CpuArch;
}

export function DownloadButton({ os, arch, again, primary = true }: PlatformProps & { again?: boolean; primary?: boolean }) {
    const asset = installerAsset(os, arch);
    if (!asset) return null;
    // A new tab, not this one: GitHub answers with an attachment, which Chrome
    // turns into a download and closes the tab — but were it ever a page
    // instead, it must not navigate away the app holding the vault.
    return (
        <a
            className={'agent-btn' + (primary ? ' primary' : '')}
            href={asset.url}
            target="_blank"
            rel="noopener noreferrer"
        >
            {again ? 'Download installer again' : `Download for ${asset.label}`}
        </a>
    );
}

function OtherArch({ os, arch }: PlatformProps) {
    if (os !== 'linux') return null;
    const other = installerAsset('linux', arch === 'arm64' ? 'x64' : 'arm64');
    if (!other) return null;
    return (
        <a className="agent-link" href={other.url} target="_blank" rel="noopener noreferrer">
            {other.label} instead
        </a>
    );
}

function InstallSteps({ os, arch }: PlatformProps) {
    return (
        <ul className="agent-substeps">
            {openInstallerSteps(os, arch).map((step, i) => (
                <li key={i}>
                    {step.text}
                    {step.command && <CommandLine command={step.command} />}
                </li>
            ))}
        </ul>
    );
}

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

function Screen({ orb, title, children }: { orb?: ReactNode; title: string; children: ReactNode }) {
    return (
        <div className="agent-screen">
            <div className="agent-screen-head">
                {orb ?? <Orb variant="S1" size={22} label={title} still />}
                <h2>{title}</h2>
            </div>
            {children}
        </div>
    );
}

export interface SetupGuideProps extends PlatformProps {
    supported: boolean;
    bridge: BridgeState;
    onConnect: () => void;
}

export function SetupGuide({ supported, bridge, os, arch, onConnect }: SetupGuideProps) {
    if (!supported) {
        return (
            <Screen title="Not available here">
                <p className="agent-lede">
                    The AI agent needs Chrome (or another Chromium browser) on macOS, Windows or Linux.
                </p>
            </Screen>
        );
    }

    if (bridge.status === 'connecting' || bridge.status === 'checking') {
        return (
            <Screen title={`Connecting to ${HELPER_NAME}…`} orb={<Orb variant="S3" size={22} label="Connecting" />}>
                <p className="agent-lede">If Chrome asks to reach devices on your local network, choose <b>Allow</b>.</p>
            </Screen>
        );
    }

    if (bridge.status === 'uninstalled') {
        return (
            <Screen title={`${HELPER_NAME} was removed`}>
                <p className="agent-lede">Your chats are kept. To use the agent again, install it again.</p>
                <div className="agent-actions">
                    <DownloadButton os={os} arch={arch} again />
                    <button type="button" className="agent-btn" onClick={onConnect}>Connect</button>
                </div>
                <InstallSteps os={os} arch={arch} />
            </Screen>
        );
    }

    if (bridge.status === 'failed') {
        const { problem, retryAt } = bridge;
        const retrying = retryAt != null;
        const retry = (
            <button type="button" className="agent-btn" onClick={onConnect}>{retrying ? 'Retry now' : 'Retry'}</button>
        );
        switch (problem.kind) {
            case 'not-found':
                return (
                    <Screen title={`${HELPER_NAME} isn't running`} orb={retrying ? <Orb variant="B2" size={22} label="Waiting" /> : undefined}>
                        <p className="agent-lede">
                            Nothing answered on this computer.{retrying ? ' Trying again automatically.' : ''} If it isn't installed yet:
                        </p>
                        <div className="agent-actions">
                            <DownloadButton os={os} arch={arch} />
                            {retry}
                        </div>
                        <InstallSteps os={os} arch={arch} />
                    </Screen>
                );
            case 'lost':
                return (
                    <Screen title="Connection lost" orb={retrying ? <Orb variant="B2" size={22} label="Reconnecting" /> : undefined}>
                        <p className="agent-lede">
                            {HELPER_NAME} stopped answering.{retrying ? ' Reconnecting automatically.' : ''}
                        </p>
                        <div className="agent-actions">{retry}</div>
                    </Screen>
                );
            case 'foreign':
                return (
                    <Screen title="Something else answered">
                        <p className="agent-lede">
                            A program on port {problem.port} answered, but it isn't a {HELPER_NAME} that accepts this site.
                            Quit that program, or reinstall {HELPER_NAME}, then retry.
                        </p>
                        <p className="agent-muted">{HELPER_NAME} uses ports {HELPER_PORTS[0]}–{HELPER_PORTS[HELPER_PORTS.length - 1]}.</p>
                        <div className="agent-actions">
                            <DownloadButton os={os} arch={arch} primary={false} />
                            {retry}
                        </div>
                    </Screen>
                );
            case 'permission-denied':
                return (
                    <Screen title="Chrome is blocking the connection">
                        <p className="agent-lede">
                            This site isn't allowed to reach apps on your computer. Click the icon left of the address bar,
                            open <b>Site settings</b>, set <b>Local network access</b> to <b>Allow</b>, then retry.
                        </p>
                        <p className="agent-muted">Site: {window.location.origin}</p>
                        <div className="agent-actions">{retry}</div>
                    </Screen>
                );
            case 'outdated':
                return (
                    <Screen title={`Update ${HELPER_NAME}`}>
                        <p className="agent-lede">
                            {HELPER_NAME} {problem.version} is older than this editor needs ({MIN_HELPER_VERSION} or newer).
                            Download the installer and open it — it replaces the old version.
                        </p>
                        <div className="agent-actions">
                            <DownloadButton os={os} arch={arch} />
                            {retry}
                        </div>
                        <InstallSteps os={os} arch={arch} />
                    </Screen>
                );
            case 'page-outdated':
                return (
                    <Screen title="Reload this page">
                        <p className="agent-lede">{HELPER_NAME} is newer than this page. Reload to get the matching editor.</p>
                        <div className="agent-actions">
                            <button type="button" className="agent-btn primary" onClick={() => window.location.reload()}>Reload</button>
                        </div>
                    </Screen>
                );
        }
    }

    // idle, but this browser has used the helper before: the reload of a
    // public page whose permission Chrome would not report as granted (so no
    // auto-connect) must not look like a first run all over again.
    if (hasConnectedBefore()) {
        return (
            <Screen title={`Connect to ${HELPER_NAME}`}>
                <p className="agent-lede">{HELPER_NAME} is set up on this computer. Connect to pick up where you left off.</p>
                <div className="agent-actions">
                    <button type="button" className="agent-btn primary" onClick={onConnect}>Connect</button>
                    <DownloadButton os={os} arch={arch} again primary={false} />
                </div>
            </Screen>
        );
    }

    // idle: the first-time guide.
    return (
        <Screen title="Set up the AI agent">
            <p className="agent-lede">
                Chat with Claude Code, Codex or OpenCode about what you're looking at. It runs on this computer
                with your agent's full access, and its edits to this vault land in your editor.
            </p>
            <ol className="agent-steps">
                <li>
                    <h3>Log in to your agent in a terminal</h3>
                    <LoginLines />
                </li>
                <li>
                    <h3>Install {HELPER_NAME}</h3>
                    <div className="agent-actions">
                        <DownloadButton os={os} arch={arch} />
                        <OtherArch os={os} arch={arch} />
                    </div>
                    <InstallSteps os={os} arch={arch} />
                </li>
                <li>
                    <h3>Connect</h3>
                    <div className="agent-actions">
                        <button type="button" className="agent-btn primary" onClick={onConnect}>Connect</button>
                    </div>
                    <p className="agent-muted">Chrome will ask to reach devices on your local network: choose Allow.</p>
                </li>
            </ol>
        </Screen>
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
