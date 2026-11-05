// The one-line strip under the header that says a newer VaultAgent is out,
// that an update failed, or that one just landed — a quiet notice
// line, not a card: secondary text, the verb in the accent, a small × at the
// right. The ⋯ menu's Update row does the same job without the nudge, so
// dismissing the strip loses nothing.
//
// While an update runs, UpdateProgress takes the strip's place: the phase as
// a shimmering label over a thin accent line, the conversation readable
// beneath (it used to be a full-panel screen that hid the chat).

import { useEffect, useState } from 'react';
import { HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import { agentBridge } from '../../utils/agentBridge';
import type { BridgeState, HelperInfo, UpdateStatus } from '../../utils/agentBridge';
import { installerAsset } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { X } from './ui/icons';
import { IconButton } from './ui/IconButton';
import { Shimmer } from './ui/Shimmer';

/** The version whose "is available" strip the user closed. Per version, so the
 *  next release asks again. */
const DISMISSED_KEY = 'vaultAgentUpdateDismissed';
/** Long enough to read "Updated to …" after the panel reconnects. */
const UPDATED_NOTICE_MS = 8000;

function readDismissed(): string | null {
    try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

function writeDismissed(version: string): void {
    try { localStorage.setItem(DISMISSED_KEY, version); } catch { /* storage blocked — it shows again next load */ }
}

interface UpdateBarProps {
    helper: HelperInfo;
    update: UpdateStatus;
    os: OsKind;
    arch: CpuArch;
    onUpdate: () => void;
}

function Dismiss({ onClick }: { onClick: () => void }) {
    return (
        <IconButton size="24" className="agent-strip-close" label="Dismiss" onClick={onClick}>
            <X />
        </IconButton>
    );
}

export function UpdateBar({ helper, update, os, arch, onUpdate }: UpdateBarProps) {
    const [dismissed, setDismissed] = useState(readDismissed);

    const kind = update.kind;
    useEffect(() => {
        if (kind !== 'updated') return;
        const id = window.setTimeout(() => agentBridge.dismissUpdateNotice(), UPDATED_NOTICE_MS);
        return () => window.clearTimeout(id);
    }, [kind]);

    if (update.kind === 'available') {
        if (dismissed === update.latest) return null;
        const latest = update.latest;
        return (
            <div className="agent-strip agent-update-bar" role="status">
                <span className="agent-strip-text">{HELPER_NAME} {latest} is available ·</span>
                <button type="button" className="agent-strip-act" onClick={onUpdate}>Update</button>
                <Dismiss onClick={() => { writeDismissed(latest); setDismissed(latest); }} />
            </div>
        );
    }

    if (update.kind === 'failed') {
        const asset = installerAsset(os, arch);
        return (
            <div className="agent-strip agent-update-bar is-failed" role="alert">
                {/* The helper's own message is the hover: the line stays one line. */}
                <span className="agent-strip-text" data-tooltip={`${update.message} ${HELPER_NAME} ${helper.version} is still running.`}>
                    <b className="agent-strip-bad">Couldn't</b> update ·
                </span>
                <button type="button" className="agent-strip-act" onClick={onUpdate}>Try again</button>
                {/* A new tab, like DownloadButton: never navigate away the app holding the vault. */}
                {asset && (
                    <>
                        <span className="agent-strip-sep" aria-hidden="true">·</span>
                        <a className="agent-strip-link" href={asset.url} target="_blank" rel="noopener noreferrer">Download installer</a>
                    </>
                )}
                {/* Closing the failure closes the offer under it too: going
                    back to "is available" took a second × (measured). The
                    next release asks again. */}
                <Dismiss onClick={() => {
                    if (update.latest) { writeDismissed(update.latest); setDismissed(update.latest); }
                    agentBridge.dismissUpdateNotice();
                }} />
            </div>
        );
    }

    if (update.kind === 'updated') {
        return (
            <div className="agent-strip agent-update-bar" role="status">
                <span className="agent-strip-text">Updated to {HELPER_NAME} {helper.version}.</span>
                <Dismiss onClick={() => agentBridge.dismissUpdateNotice()} />
            </div>
        );
    }

    return null;
}

type Updating = Extract<BridgeState, { status: 'updating' }>;

function percentOf({ received, total }: Updating): number | null {
    if (received == null || !total) return null;
    return Math.min(100, Math.floor((received / total) * 100));
}

/** The phase in a few words — the gate's sentences, shortened for one line. */
function phaseLabel(u: Updating, percent: number | null): string {
    const target = u.target ? ` ${u.target}` : '';
    switch (u.phase) {
        case 'checking': return 'Checking for the latest release…';
        case 'downloading': return `Downloading ${HELPER_NAME}${target}…${percent == null ? '' : ` ${percent}%`}`;
        case 'verifying': return 'Checking the new version…';
        case 'installing': return `Installing ${HELPER_NAME}${target}…`;
        case 'restarting': return `Restarting ${HELPER_NAME}…`;
    }
}

/** The update in progress: one line under the header, the chat below it. The
 *  line fills with the download and slides while the size (or the end) is
 *  not known. */
export function UpdateProgress({ bridge }: { bridge: Updating }) {
    const percent = bridge.phase === 'downloading' ? percentOf(bridge) : null;
    return (
        <div className="agent-strip agent-update-progress" role="status">
            <Shimmer className="agent-strip-text">{phaseLabel(bridge, percent)}</Shimmer>
            <span
                className={'agent-update-line' + (percent == null ? ' is-indeterminate' : '')}
                role="progressbar"
                aria-label={`Updating ${HELPER_NAME}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
            >
                <span style={percent == null ? undefined : { width: `${percent}%` }} />
            </span>
        </div>
    );
}
