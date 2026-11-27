import { useEffect, useState } from 'react';
import { HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import { agentBridge } from '../../utils/agentBridge';
import type { HelperInfo, UpdateStatus } from '../../utils/agentBridge';
import { installerAsset } from '../../utils/platform';
import type { CpuArch, OsKind } from '../../utils/platform';
import { X } from '../icons';
import { writeStoredValue } from '../../utils/storage';

const DISMISSED_KEY = 'vaultAgentUpdateDismissed';
const UPDATED_NOTICE_MS = 8000;

function readDismissed(): string | null {
    try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

function writeDismissed(version: string): void {
    writeStoredValue(DISMISSED_KEY, version);
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
