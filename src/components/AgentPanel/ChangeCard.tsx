// A vault edit or a new note the agent made, drawn as a card for the file it
// touched: a header naming the note ("Notes/Ideas.md", "Edited · +1 −1") that
// opens it, over the changed lines. No line-number columns — in a 360px column
// two of them took a fifth of the width, and the note is one click away for
// anyone who wants to know where a line sits.
//
// The body shows eight rows; a long rewrite folds the rest behind "Show N more
// lines" rather than pushing the reply below it out of sight.

import { memo, useState } from 'react';
import type { AgentChange, AgentHost, DiffLine } from '../../types/vaultAgent';
import { File } from './ui/icons';

type CardChange = Extract<AgentChange, { kind: 'edit' | 'create' }>;

const VISIBLE_ROWS = 8;

const ROW_CLASS: Record<DiffLine['type'], string> = { context: 'is-ctx', add: 'is-add', del: 'is-del', gap: 'is-gap' };

function ChangeCardImpl({ change, host }: { change: CardChange; host: AgentHost }) {
    const [all, setAll] = useState(false);
    // Blank context rows say nothing; a card saved before agentDiff stopped
    // making them (three lines a side, blanks included) still has them.
    const rows = change.diff.filter(l => l.type !== 'context' || l.text.trim());
    const shown = all ? rows : rows.slice(0, VISIBLE_ROWS);
    const hidden = rows.length - shown.length;
    const added = change.kind === 'edit' ? change.added : rows.filter(l => l.type === 'add').length;
    const removed = change.kind === 'edit' ? change.removed : 0;
    return (
        <div className="va-card">
            <button
                type="button"
                className="va-cardh"
                onClick={() => host.openFile(change.path)}
                aria-label={`Open ${change.path}`}
            >
                <span className="va-card-box" aria-hidden="true"><File /></span>
                <span className="va-card-titles">
                    {/* Ellipsis at the START (direction: rtl on the box, the
                        path isolated ltr inside): the file's name is the part
                        that says which note it was, its folders the part to
                        lose. */}
                    <span className="va-card-path"><bdi>{change.path}</bdi></span>
                    <span className="va-card-sub">
                        {change.kind === 'edit'
                            ? <>Edited · <span className="va-add">+{added}</span> <span className="va-del">−{removed}</span></>
                            : 'New file'}
                    </span>
                </span>
                <span className="va-card-open" aria-hidden="true">Open</span>
            </button>
            {shown.length > 0 && (
                <div className="va-diff">
                    {shown.map((line, i) => (
                        <div key={i} className={'va-diff-row ' + ROW_CLASS[line.type]}>
                            {line.type === 'gap' ? (line.text || '⋯') : (line.text || ' ')}
                        </div>
                    ))}
                    {hidden > 0 && (
                        <button type="button" className="va-diff-more" onClick={() => setAll(true)}>
                            Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export const ChangeCard = memo(ChangeCardImpl);

