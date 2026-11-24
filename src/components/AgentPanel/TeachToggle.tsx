// The cap beside the model chip: how the agent should answer.
//
// Three states, because two would not cover it (utils/agentReplyMode.ts has the
// reasoning and the rules the model is given):
//
//   auto    the editor decides per message, and the cap LIGHTS on the ones it
//           decided to teach — so "we are in learning mode now" is visible
//           without the user having pinned anything.
//   on      every message is taught, whatever it looks like.
//   off     never taught; answer and stop.
//
// One button rather than a popover: it is a preference someone flips while
// reading, and a menu for three states costs two clicks each time.

import { useSyncExternalStore } from 'react';
import { GraduationCap } from '../icons';
import { getReplyModePref, nextReplyModePref, setReplyModePref, subscribeReplyMode } from '../../utils/agentReplyMode';
import type { ReplyModePref } from '../../utils/agentReplyMode';
import { chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';

/** What the cap says it will do, and what a click does next. */
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
    // Lit while a lesson is actually under way: pinned on, or `auto` having
    // decided to teach this chat.
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
