import { useSyncExternalStore } from 'react';
import { GraduationCap } from '../icons';
import { getReplyModePref, nextReplyModePref, setReplyModePref, subscribeReplyMode } from '../../utils/agentReplyMode';
import type { ReplyModePref } from '../../utils/agentReplyMode';
import { chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';

const TOOLTIP: Record<ReplyModePref, string> = {
    auto: 'Learning mode: automatic — teaches step by step when you are learning something. Click to keep it on',
    teach: 'Learning mode: on — every answer is taught step by step. Click to turn it off',
    direct: 'Learning mode: off — always answers directly. Click for automatic',
};

const LABEL: Record<ReplyModePref, string> = {
    auto: 'Learning mode: automatic',
    teach: 'Learning mode: on',
    direct: 'Learning mode: off',
};

export function TeachToggle({ state }: { state: ChatStoreState }) {
    const pref = useSyncExternalStore(subscribeReplyMode, getReplyModePref);
    const teaching = pref === 'teach' || (pref === 'auto' && chatStore.isTeaching());
    // `state` is read so the cap re-renders when the store does — the lesson
    // flag lives there, and `isTeaching()` reads the chat that is on screen.
    void state;

    return (
        <button
            type="button"
            className={`agent-chip agent-teach is-${pref}${teaching ? ' is-teaching' : ''}`}
            aria-label={LABEL[pref]}
            aria-pressed={pref === 'teach'}
            data-tooltip={TOOLTIP[pref]}
            data-tooltip-position="top"
            onClick={() => setReplyModePref(nextReplyModePref(pref))}
        >
            <GraduationCap size={14} aria-hidden="true" />
        </button>
    );
}
