// The composer's model selector ("Opus · High ⌄", drawn as plain text) and
// its menu: the model families first, each with a one-line reason, "More
// models ›" for the rest, then Effort as a segmented control. Per chat; applies
// from the next message; the last choice becomes the default for new chats with
// that agent (chatStore.setModel).
//
// `ModelRows` and `EffortSection` are exported (with modelChoice.ts): the
// sliders menu shows the same Effort, and a retry menu listing models can
// match these rows.

import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import type { ModelInfo } from '../../../shared/vaultAgentProtocol';
import { DEFAULT_EFFORT, describeModel, isAlias, menuModels, modelChoice, shortModelLabel } from './modelChoice';
import type { ModelChoice } from './modelChoice';
import type { Theme } from '../../types';
import { getReplyModePref, subscribeReplyMode } from '../../utils/agentReplyMode';
import { ChevronDown, GraduationCap } from './ui/icons';
import { MenuRow, MenuSection, MenuSeparator } from './ui/MenuRow';
import { Segmented } from './ui/Segmented';
import { PopoverRoleContext } from './ui/popoverRole';
import { Popover } from './Popover';
import { chatStore } from './chatStore';
import type { ChatStoreState } from './chatStore';
import { effortLabel } from './useAgentChat';

function effortName(level: string): string {
    return level === DEFAULT_EFFORT ? 'Default' : effortLabel(level);
}

/** A segment's text once five levels share the control (Claude's Low … Max):
 *  at the 272px model menu each segment is 45px, and "Extra high" needs 60,
 *  "Medium" 48 (measured, 12.5px UI face) — content-width segments were the
 *  crowded, uneven row; equal ones truncated to "Medi…". The full name stays
 *  the segment's accessible name and tooltip. */
const SHORT_EFFORT: Record<string, string> = { minimal: 'Min', medium: 'Med', xhigh: 'X-high' };

/** "Effort" over a segmented control of the model's levels — the model menu's
 *  and the sliders menu's, one setting shown in both places. The retry menu
 *  passes `effort` and `onChange`: its choice is for that one run, not the
 *  chat's (null = the model's own default). */
export function EffortSection({ choice, effort = choice.effort, onChange }: {
    choice: ModelChoice;
    effort?: string | null;
    onChange?: (effort: string | null) => void;
}) {
    if (!choice.effortLevels.length) return null;
    const set = onChange ?? ((next: string | null) => chatStore.setModel(choice.config.model, next));
    const crowded = choice.effortLevels.length >= 5;
    return (
        <>
            <MenuSection label="Effort" />
            <Segmented
                label="Effort"
                options={choice.effortLevels}
                value={effort ?? DEFAULT_EFFORT}
                format={crowded ? level => SHORT_EFFORT[level] ?? effortName(level) : effortName}
                fullName={effortName}
                onChange={next => set(next === DEFAULT_EFFORT ? null : next)}
            />
        </>
    );
}

/** The model rows: families first, then "More models ›" for the rest. */
export function ModelRows({ models, chosen, onPick }: {
    models: ModelInfo[];
    chosen: ModelInfo | null;
    onPick: (model: ModelInfo) => void;
}) {
    // Reset with every mount: the short list is the way in.
    const [all, setAll] = useState(false);
    const { first, rest } = menuModels(models, chosen);
    const pinsExist = models.some(isAlias) && models.some(m => !isAlias(m));
    const shown = all ? models : first;
    // "More models" unmounts as it is chosen, and the keyboard fell to <body>
    // with it (measured; ↓ then did nothing): it moves on to the first model it
    // brought in. A click lands there too, without a ring (not focus-visible).
    const firstNew = useRef<HTMLButtonElement>(null);
    useEffect(() => { if (all) firstNew.current?.focus({ preventScroll: true }); }, [all]);
    // A radio group in a dialog (the model and retry menus); in a menu, a
    // group of menuitemradios, the only grouping a menu may own.
    const inMenu = useContext(PopoverRoleContext) === 'menu';
    return (
        <>
            <div role={inMenu ? 'group' : 'radiogroup'} aria-label="Model" className="agent-pop-view">
                {shown.map(m => (
                    <MenuRow
                        key={m.id}
                        ref={all && m.id === rest[0]?.id ? firstNew : undefined}
                        title={shortModelLabel(m.label)}
                        description={describeModel(m, pinsExist)}
                        checked={m.id === chosen?.id}
                        onSelect={() => onPick(m)}
                    />
                ))}
            </div>
            {!all && rest.length > 0 && (
                <MenuRow className="is-quiet" title="More models" more onSelect={() => setAll(true)} />
            )}
        </>
    );
}

export function ModelPicker({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const pref = useSyncExternalStore(subscribeReplyMode, getReplyModePref);
    const choice = modelChoice(state);
    const { config, entry, models, model, effort } = choice;
    // The cap says a lesson is under way: pinned Always, or `auto` having
    // decided to teach this chat. `state` re-renders this when the latter moves.
    const teaching = pref === 'teach' || (pref === 'auto' && chatStore.isTeaching());

    const label = model
        ? shortModelLabel(model.label)
        // "Default", as a ready selector names that row ("Default · High"):
        // "Default model" read as a different thing when the agent was blocked.
        : entry?.status === 'loading' ? 'Loading models…' : 'Default';
    const effortText = model && effort && model.efforts.length ? effortName(effort) : null;

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        void chatStore.ensureModels(config.agent);
        setAnchor(e.currentTarget);
    };

    // A model is one choice, so picking it is done (the Effort control is the
    // part that stays open while it is changed).
    const pick = (next: ModelInfo) => {
        setAnchor(null);
        // Keep the effort when the new model offers it; else its own default.
        const keep = config.effort && next.efforts.includes(config.effort) ? config.effort : null;
        chatStore.setModel(next.id, keep);
    };

    return (
        <>
            <button
                type="button"
                className="agent-model-btn"
                aria-haspopup="dialog"
                aria-expanded={anchor !== null}
                aria-label={`Model: ${label}${effortText ? `, effort ${effortText}` : ''}${teaching ? ', learning mode is teaching' : ''}`}
                disabled={disabled}
                onClick={toggle}
                data-tooltip="Model and effort"
                data-tooltip-position="top"
            >
                {teaching && <GraduationCap className="agent-model-cap" aria-hidden="true" />}
                <span className="agent-model-label">
                    {label}
                    {effortText && <span className="agent-model-effort"> · {effortText}</span>}
                </span>
                <ChevronDown className="agent-model-chev" aria-hidden="true" />
            </button>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Model and effort" role="dialog" placement="above" align="end" className="agent-model-popover">
                    <MenuSection label="Model" />
                    {entry?.status === 'error' && (
                        <div className="agent-pop-hint">
                            Couldn't load the models. {entry.error}{' '}
                            <button type="button" className="agent-text-btn" onClick={() => void chatStore.ensureModels(config.agent, true)}>Retry</button>
                        </div>
                    )}
                    {entry?.status === 'loading' && !models.length && <div className="agent-pop-hint">Loading…</div>}
                    <ModelRows models={models} chosen={model} onPick={pick} />
                    {choice.effortLevels.length > 0 && <MenuSeparator />}
                    <EffortSection choice={choice} />
                </Popover>
            )}
        </>
    );
}
