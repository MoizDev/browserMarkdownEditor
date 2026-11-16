// Settings → Vault → "Keep this data on this device".
//
// The honest answer to "where does all this live, and can it disappear?": the
// vault list (the folder handles themselves), the open tabs, reading positions,
// every setting and the crash-recovery journal are in this browser's storage and nowhere else, and a
// "best effort" origin can be evicted under storage pressure without a word.
// utils/storagePersistence.ts has the mechanism; this row is the only place the
// app says out loud which of the two it is living under (the recovery journal's own
// refusal notice was removed: a status-line warning at every page load's first edit,
// about something the user cannot act on), and the one place a
// user can ask for the better one on purpose.
//
// Chrome grants persistence from engagement rather than a prompt, so the button
// may simply not take. It says so instead of pretending, because a control that
// silently does nothing is worse than one that reports a refusal.

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    checkStorageDurability, getStorageDurability, requestPersistentStorage, subscribeStorageDurability,
} from '../utils/storagePersistence';

export function StorageDurabilitySetting() {
    const durability = useSyncExternalStore(subscribeStorageDurability, getStorageDurability);
    const [asked, setAsked] = useState(false);

    // Only while the panel is open: nothing else in the app reads this, and a
    // check on every load would be a question asked for nobody.
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
                {/* Plain and muted, not a `settings-value` chip: that chip is
                    the accent, and beside an accent button a chip reads as a
                    second button rather than as the state the button changes. */}
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
