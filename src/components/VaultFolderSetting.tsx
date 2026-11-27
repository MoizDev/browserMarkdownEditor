// IT ASKS THE HELPER ONLY WHEN THE PANEL IS OPEN, and only when a connection
// already exists: Settings must never be the thing that raises Chrome's Local
// Network Access prompt (the rule agentBridge exists to keep). With no helper
// it simply says so.

import { useEffect, useRef, useState } from 'react';
import { agentBridge } from '../utils/agentBridge';

type Status =
    | { kind: 'idle' }
    | { kind: 'offline' }
    | { kind: 'looking' }
    | { kind: 'found'; path: string }
    | { kind: 'missing' }
    | { kind: 'rejected' };

export function VaultFolderSetting({ vaultId }: { vaultId: string | null }) {
    const [status, setStatus] = useState<Status>({ kind: 'idle' });
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!vaultId) { setStatus({ kind: 'idle' }); return; }
        if (agentBridge.getState().status !== 'connected') { setStatus({ kind: 'offline' }); return; }
        let alive = true;
        setStatus({ kind: 'looking' });
        agentBridge.request('vault.path', { vaultId }).then(
            ({ path }) => { if (alive) setStatus(path ? { kind: 'found', path } : { kind: 'missing' }); },
            () => { if (alive) setStatus({ kind: 'offline' }); },
        );
        return () => { alive = false; };
    }, [vaultId]);

    const save = () => {
        const typed = input.current?.value.trim();
        if (!vaultId || !typed) return;
        setStatus({ kind: 'looking' });
        agentBridge.request('vault.path', { vaultId, set: typed }).then(
            ({ path }) => setStatus(path ? { kind: 'found', path } : { kind: 'rejected' }),
            () => setStatus({ kind: 'offline' }),
        );
    };

    const hint = {
        idle: 'Open a vault to set this.',
        offline: 'Connect VaultAgent to see where this vault is.',
        looking: 'Looking…',
        found: '',
        missing: "VaultAgent couldn't find this vault. Paste its full path to start terminals in it.",
        rejected: "That folder isn't this vault (no matching .VaultAgent/vault.json in it).",
    }[status.kind];

    return (
        <div className="setting-row">
            <div className="setting-info">
                <div className="setting-name">Vault folder on disk</div>
                <div className="settings-hint">
                    Where this vault lives, so a new terminal can start in the folder of the file you are in.
                    VaultAgent normally finds it by itself. {hint}
                </div>
            </div>
            <div className="setting-control">
                <input
                    ref={input}
                    key={status.kind === 'found' ? status.path : status.kind}
                    type="text"
                    className="settings-text-input"
                    placeholder={status.kind === 'found' ? status.path : '/Users/you/Documents/Vault'}
                    defaultValue={status.kind === 'found' ? status.path : ''}
                    disabled={!vaultId || status.kind === 'offline'}
                    onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                    spellCheck={false}
                    autoCorrect="off"
                />
                <button className="settings-apply-btn" onClick={save} disabled={!vaultId || status.kind === 'offline'}>
                    Apply
                </button>
            </div>
        </div>
    );
}
