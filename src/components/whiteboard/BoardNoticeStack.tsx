import type { BoardNotices } from './boardNotices';

export function BoardNoticeStack({ notices }: { readonly notices: BoardNotices }) {
    if (!notices.list.length) return null;
    return <div className="board-viewer-notice board-viewer-notices" role="status">
        {notices.list.map(message => <div key={message} className="board-viewer-notice-dismissible">
            <span>{message}</span>
            <button type="button" className="disk-bar-btn" onClick={() => notices.dismiss(message)}>Dismiss</button>
        </div>)}
    </div>;
}
