import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    checkStorageDurability, getStorageDurability, requestPersistentStorage, subscribeStorageDurability,
} from '../utils/storagePersistence';

export function StorageDurabilitySetting() {
    const durability = useSyncExternalStore(subscribeStorageDurability, getStorageDurability);
    const [asked, setAsked] = useState(false);

    useEffect(() => { void checkStorageDurability(); }, []);

    const hint = {
        persisted: 'This browser keeps your vault list, open tabs, settings and the recovery copies of unsaved edits until you clear this site’s data yourself. The files in your vault folder are never affected.',
        'best-effort': 'If your disk runs low on space, this browser may clear your vault list, open tabs, settings and the recovery copies of unsaved edits. The files in your vault folder are not affected. Installing this app from the address bar, or bookmarking it, usually lets the browser keep them.',
        unknown: 'This browser does not say whether it keeps your vault list, open tabs, settings and the recovery copies of unsaved edits. The files in your vault folder are not affected.',
    }[durability];

    const refused = asked && durability !== 'persisted';

    return (
        <div className="setting-row">
            <div className="setting-info">
                <div className="setting-name">Keep this data on this device</div>
                <div className="settings-hint">
                    {hint}
                    {refused && ' Your browser said no for now. It decides this itself, mostly for sites you install, bookmark or use often, so ask again after doing one of those.'}
                </div>
            </div>
            <div className="setting-control">
                <span className="settings-status">
                    {durability === 'persisted' ? 'Kept' : durability === 'best-effort' ? 'Can be cleared' : 'Unknown'}
                </span>
                <button
                    className="settings-apply-btn"
                    disabled={durability === 'persisted'}
                    onClick={() => { setAsked(true); void requestPersistentStorage(); }}
                >
                    {durability === 'persisted' ? 'Kept' : 'Ask to keep'}
                </button>
            </div>
        </div>
    );
}
