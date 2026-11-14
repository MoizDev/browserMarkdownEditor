import { useId, useState, useSyncExternalStore } from 'react';
import { getBoardDictionary, removeBoardDictionaryWord, subscribeBoardDictionary } from '../utils/boardDictionary';

export function BoardDictionarySetting() {
    const words = useSyncExternalStore(subscribeBoardDictionary, getBoardDictionary);
    const [open, setOpen] = useState(false);
    const listId = useId();
    return <div>
        <div className="setting-row">
            <div className="setting-info">
                <div className="setting-name">Board dictionary</div>
                <div className="settings-hint">{words.length ? `${words.length} ${words.length === 1 ? 'word' : 'words'}` : 'No words added'}</div>
            </div>
            <div className="setting-control">
                <button type="button" className="settings-apply-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
                    {open ? 'Hide' : 'Manage'}
                </button>
            </div>
        </div>
        {open && <div id={listId} style={{ maxHeight: 240, overflowY: 'auto' }}>
            {words.map(word => <div key={word} style={{ contentVisibility: 'auto', containIntrinsicSize: '36px', height: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{word}</span>
                <button type="button" className="settings-apply-btn" aria-label={`Remove ${word}`} onClick={() => removeBoardDictionaryWord(word)}>Remove</button>
            </div>)}
        </div>}
    </div>;
}
