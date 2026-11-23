// The strip under the header that says a newer VaultAgent is out, that an
// update failed, or that one just landed. The ⋯ menu's Update row does the
// same job without the nudge, so dismissing the strip loses nothing.

import { useEffect, useState } from 'react';
import { HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import { agentBridge } from '../../utils/agentBridge';
import type { HelperInfo, UpdateStatus } from '../../utils/agentBridge';
import { installerAsset } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { X } from '../icons';

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

export function UpdateBar({ helper, update, os, arch, onUpdate }: UpdateBarProps) {
    const [dismissed, setDismissed] = useState(readDismissed);

    const kind = update.kind;
    useEffect(() => {
        if (kind !== 'updated') return;
        const id = window.setTimeout(() => agentBridge.dismissUpdateNotice(), UPDATED_NOTICE_MS);
        return () => window.clearTimeout(id);
    }, [kind]);

    const close = (onClick: () => void) => (
        <button
            type="button"
            className="agent-icon-btn agent-update-close"
            aria-label="Dismiss"
            data-tooltip="Dismiss"
            onClick={onClick}
        >
            <X size={14} />
        </button>
    );

    if (update.kind === 'available') {
        if (dismissed === update.latest) return null;
        const latest = update.latest;
        return (
            <div className="agent-notice info agent-update-bar" role="status">
                <p className="agent-update-text"><b>{HELPER_NAME} {latest}</b> is available.</p>
                <div className="agent-update-actions">
                    <button type="button" className="agent-btn primary small" onClick={onUpdate}>Update</button>
                    {close(() => { writeDismissed(latest); setDismissed(latest); })}
                </div>
            </div>
        );
    }

    if (update.kind === 'failed') {
        const asset = installerAsset(os, arch);
        return (
            <div className="agent-notice error agent-update-bar is-stacked" role="alert">
                <p className="agent-update-text">
                    Couldn't update {HELPER_NAME}: {update.message} {HELPER_NAME} {helper.version} is still running.
                </p>
                <div className="agent-update-actions">
                    <button type="button" className="agent-btn small" onClick={onUpdate}>Try again</button>
                    {/* A new tab, like DownloadButton: never navigate away the app holding the vault. */}
                    {asset && (
                        <a className="agent-link" href={asset.url} target="_blank" rel="noopener noreferrer">
                            Download installer
                        </a>
                    )}
                    {close(() => agentBridge.dismissUpdateNotice())}
                </div>
            </div>
        );
    }

    if (update.kind === 'updated') {
        return (
            <div className="agent-notice success agent-update-bar" role="status">
                <p className="agent-update-text">Updated to {HELPER_NAME} {helper.version}.</p>
                <div className="agent-update-actions">
                    {close(() => agentBridge.dismissUpdateNotice())}
                </div>
            </div>
        );
    }

    return null;
}
