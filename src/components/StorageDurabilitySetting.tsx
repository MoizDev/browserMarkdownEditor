// Settings → Vault → "Keep this data on this device".
//
// The honest answer to "where does all this live, and can it disappear?": the
// vault list (the folder handles themselves), the open tabs, reading positions
// and every setting are in this browser's storage and nowhere else, and a
// "best effort" origin can be evicted under storage pressure without a word.
// utils/storagePersistence.ts has the mechanism; this row is the only place the
// app says out loud which of the two it is living under, and the one place a
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
        persisted: 'Your vault list, open tabs and settings are kept until you clear this site’s data yourself.',
        'best-effort': 'Your browser may clear your vault list, open tabs and settings if it runs short of space.',
        unknown: 'This browser does not say whether it keeps site data, so treat the vault list as replaceable.',
    }[durability];

    const refused = asked && durability !== 'persisted';

    return (
        <div className="setting-row">
            <div className="setting-info">
                <div className="setting-name">Keep this data on this device</div>
                <div className="settings-hint">
                    {hint}
                    {refused && ' Your browser decided not to — it grants this to sites you use often, so try again after a few more visits, or install this app from the address bar.'}
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
