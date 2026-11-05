// The composer's sliders button and its menu: how the agent should answer
// (Learning mode) and how hard it thinks (Effort, the same setting the model
// menu shows).
//
// Learning mode is utils/agentReplyMode.ts's three states, named for the
// reader rather than by their stored values:
//
//   Auto    (auto)   the editor decides per message; the model selector shows a
//                    cap while it has decided to teach this chat.
//   Always  (teach)  every message is taught.
//   Off     (direct) never taught; answer and stop.
//
// It replaced a cap button that cycled the three on click: a state you could
// only learn by reading its tooltip, and two clicks to get anywhere.

import { useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import type { Theme } from '../../types';
import { getReplyModePref, setReplyModePref, subscribeReplyMode } from '../../utils/agentReplyMode';
import type { ReplyModePref } from '../../utils/agentReplyMode';
import { SlidersHorizontal } from './ui/icons';
import { MenuSection, MenuSeparator } from './ui/MenuRow';
import { Segmented } from './ui/Segmented';
import { Popover } from './Popover';
import { EffortSection } from './ModelPicker';
import { modelChoice } from './modelChoice';
import type { ChatStoreState } from './chatStore';

const MODES: Array<{ pref: ReplyModePref; name: string; meaning: string }> = [
    { pref: 'auto', name: 'Auto', meaning: 'Teaches step by step when you are learning something; answers directly for tasks.' },
    { pref: 'teach', name: 'Always', meaning: 'Every answer is taught step by step.' },
    { pref: 'direct', name: 'Off', meaning: 'Always answers directly.' },
];

export function ToolsMenu({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const pref = useSyncExternalStore(subscribeReplyMode, getReplyModePref);
    const mode = MODES.find(m => m.pref === pref) ?? MODES[0];
    const choice = modelChoice(state);

    const toggle = (e: MouseEvent<HTMLButtonElement>) => setAnchor(anchor ? null : e.currentTarget);

    return (
        <>
            <button
                type="button"
                className="agent-round-btn"
                aria-label="Learning mode and effort"
                aria-haspopup="dialog"
                aria-expanded={anchor !== null}
                data-tooltip="Learning mode and effort"
                data-tooltip-position="top"
                disabled={disabled}
                onClick={toggle}
            >
                <SlidersHorizontal />
            </button>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Learning mode and effort" role="dialog" placement="above" className="agent-tools-popover">
                    <MenuSection label="Learning mode" />
                    <Segmented
                        label="Learning mode"
                        options={MODES.map(m => m.name)}
                        value={mode.name}
                        onChange={name => setReplyModePref(MODES.find(m => m.name === name)?.pref ?? 'auto')}
                    />
                    <div className="agent-pop-hint">{mode.meaning}</div>
                    {choice.effortLevels.length > 0 && <MenuSeparator />}
                    <EffortSection choice={choice} />
                </Popover>
            )}
        </>
    );
}
