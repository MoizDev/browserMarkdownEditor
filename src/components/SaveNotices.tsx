import { useSyncExternalStore, type ReactNode } from 'react';
import { dismissSaveNotice, getSaveNotices, subscribeSaveNotices } from '../utils/saveNotices';

/** The bottom-right notice column: save failures (never focused, see utils/saveNotices.ts) above the update notice. */
export default function SaveNotices({ children }: { children?: ReactNode }) {
    const notices = useSyncExternalStore(subscribeSaveNotices, getSaveNotices, getSaveNotices);
    if (!notices.length && !children) return null;
    return <div className="app-notices">
        <div className="app-notices-saves" role="alert">
            {notices.map(notice => <div key={notice.id} className="app-update-notice app-save-notice">
                <span>{notice.message}</span>
                <button type="button" aria-label="Dismiss" data-tooltip="Dismiss" onClick={() => dismissSaveNotice(notice.id)}>×</button>
            </div>)}
        </div>
        {children}
    </div>;
}
