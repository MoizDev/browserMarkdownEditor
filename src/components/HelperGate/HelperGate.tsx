// The screens that stand between a feature and VaultAgent: the first-time
// guide, and one screen per way the connection can be missing. Short on purpose
// — each says what is wrong and offers the one or two buttons that fix it.
//
// Two lazy chunks need them (the agent panel and the terminal dock), and
// VaultAgent is the same helper for both, so the screens live here once, taking
// the copy that differs. `requirement` is what the feature needs from the
// helper: the chat needs one at or above MIN_HELPER_VERSION, the terminal one
// at or above TERMINAL_VERSION. Callers render this only when `gatePasses` (gate.ts) is
// false, and keep their own scroll wrapper (the agent's `.agent-setup`, the
// dock's `.terminal-gate`).

import type { ReactNode } from 'react';
import { HELPER_NAME, HELPER_PORTS, MIN_HELPER_VERSION, TERMINAL_VERSION } from '../../../shared/vaultAgentProtocol';
import { hasConnectedBefore, type BridgeState } from '../../utils/agentBridge';
import { installerAsset, openInstallerSteps } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { CommandLine } from '../AgentPanel/CommandLine';
import { Orb } from '../AgentPanel/aicss/Orb';
import '../AgentPanel/aicss/aicss.css';
import './HelperGate.css';
import type { GateRequirement } from './gate';

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

export interface HelperGateProps extends PlatformProps {
    requirement: GateRequirement;
    supported: boolean;
    bridge: BridgeState;
    onConnect: () => void;
    onUpdate: () => void;
    /** The first-time guide's title ("Set up the AI agent"). */
    title: string;
    /** Its lede, under the title. */
    lede: ReactNode;
    /** The feature, mid-sentence: "the AI agent", "the terminal". */
    noun: string;
    /** A guide step of the feature's own, before "Install" (the agent's logins). */
    preface?: ReactNode;
}

/** The updating screen's one line, by the stage the helper reports. */
function updateLede(bridge: Extract<BridgeState, { status: 'updating' }>): string {
    const name = bridge.target ? `${HELPER_NAME} ${bridge.target}` : HELPER_NAME;
    switch (bridge.phase) {
        case 'checking': return 'Checking the latest release…';
        case 'downloading': {
            const pct = progressPercent(bridge);
            return pct == null ? `Downloading ${name}…` : `Downloading ${name}… ${pct}%`;
        }
        case 'verifying': return 'Checking the new version works on this computer…';
        case 'installing': return 'Installing…';
        case 'restarting': return `Restarting ${HELPER_NAME}…`;
    }
}

function progressPercent(bridge: Extract<BridgeState, { status: 'updating' }>): number | null {
    const { received, total } = bridge;
    if (received == null || !total) return null;
    return Math.min(100, Math.floor((received / total) * 100));
}

/** A slim bar under the lede while downloading; it slides, not fills, until
 *  the helper knows the size. */
function UpdateProgress({ percent }: { percent: number | null }) {
    return (
        <div
            className={'agent-progress' + (percent == null ? ' is-indeterminate' : '')}
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
        >
            <span style={percent == null ? undefined : { width: `${percent}%` }} />
        </div>
    );
}

export function HelperGate({
    requirement, supported, bridge, os, arch, onConnect, onUpdate, title, lede, noun, preface,
}: HelperGateProps) {
    const forTerminal = requirement === 'terminal';

    if (!supported) {
        return (
            <Screen title="Not available here">
                <p className="agent-lede">
                    {`${noun.charAt(0).toUpperCase()}${noun.slice(1)}`} needs Chrome (or another Chromium browser) on macOS, Windows or Linux.
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

    if (bridge.status === 'updating') {
        return (
            <Screen title={`Updating ${HELPER_NAME}…`} orb={<Orb variant="S3" size={22} label="Updating" />}>
                <p className="agent-lede">{updateLede(bridge)}</p>
                {bridge.phase === 'downloading' && <UpdateProgress percent={progressPercent(bridge)} />}
                {!forTerminal && <p className="agent-muted">Your chats are kept.</p>}
            </Screen>
        );
    }

    // Connected, but to a helper too old for this feature: the chat's floor is
    // MIN_HELPER_VERSION (such a helper is connected only so it can be updated,
    // or uninstalled from the ⋯ menu); the terminal's is TERMINAL_VERSION, and
    // a helper between the two still chats fine.
    if (bridge.status === 'connected' && (bridge.helper.outdated || (forTerminal && !bridge.helper.terminal))) {
        const { helper, update } = bridge;
        const heading = forTerminal ? `Update ${HELPER_NAME} to use the terminal` : `Update ${HELPER_NAME}`;
        const tooOld = forTerminal
            ? <>{HELPER_NAME} {helper.version} has no terminal yet ({TERMINAL_VERSION} or newer does).</>
            : <>{HELPER_NAME} {helper.version} is older than this editor needs ({MIN_HELPER_VERSION} or newer).</>;
        if (helper.selfUpdate && update.kind !== 'unsupported') {
            const failed = update.kind === 'failed' ? update : null;
            return (
                <Screen title={heading}>
                    <p className="agent-lede">{tooOld}</p>
                    {failed && (
                        <div className="agent-notice error" role="alert">
                            Couldn't update {HELPER_NAME}: {failed.message} You can download the installer instead.
                        </div>
                    )}
                    <div className="agent-actions">
                        <button type="button" className={'agent-btn' + (failed ? '' : ' primary')} onClick={onUpdate}>
                            {failed ? 'Try again' : 'Update'}
                        </button>
                        {failed && <DownloadButton os={os} arch={arch} />}
                    </div>
                    {failed && <InstallSteps os={os} arch={arch} />}
                </Screen>
            );
        }
        return (
            <Screen title={heading}>
                <p className="agent-lede">{tooOld} Download the installer and open it — it replaces the old version.</p>
                <div className="agent-actions">
                    <DownloadButton os={os} arch={arch} />
                    <button type="button" className="agent-btn" onClick={onConnect}>Retry</button>
                </div>
                <InstallSteps os={os} arch={arch} />
            </Screen>
        );
    }

    if (bridge.status === 'uninstalled') {
        return (
            <Screen title={`${HELPER_NAME} was removed`}>
                <p className="agent-lede">
                    {forTerminal ? 'To use the terminal again, install it again.' : 'Your chats are kept. To use the agent again, install it again.'}
                </p>
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
            // Only a helper on an older PROTOCOL is refused outright now; one that
            // is merely below MIN_HELPER_VERSION connects (the screen above).
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
            case 'update-lost':
                return (
                    <Screen title={`${HELPER_NAME} didn't come back`} orb={retrying ? <Orb variant="B2" size={22} label="Reconnecting" /> : undefined}>
                        <p className="agent-lede">
                            {problem.target
                                ? `The update to ${problem.target} was installed, but ${HELPER_NAME} hasn't restarted yet.`
                                : `${HELPER_NAME} stopped answering during the update and hasn't come back yet.`}
                            {retrying ? ' Still trying.' : ''} If it doesn't, download the installer and open it.
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
                </div>
            </Screen>
        );
    }

    // idle: the first-time guide.
    return (
        <Screen title={title}>
            <p className="agent-lede">{lede}</p>
            <ol className="agent-steps">
                {preface}
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
