// The composer's model chip ("Opus · High") and its popover: the agent's
// models from `models.list`, and the effort slider for the chosen one. Per
// chat; applies from the next message; the last choice becomes the default for
// new chats with that agent (chatStore.setModel).

import { useState } from 'react';
import type { MouseEvent } from 'react';
import type { Theme } from '../../types';
import { Check, ChevronDown } from '../icons';
import { Popover } from './Popover';
import { EffortControl } from './EffortControl';
import { chatStore, configOf, resolveModel } from './chatStore';
import type { ChatStoreState } from './chatStore';
import type { ModelInfo } from '../../../shared/vaultAgentProtocol';
import { effortLabel } from './useAgentChat';

/** The effort stop for "the model's own default" (sent as no effort). */
const DEFAULT_EFFORT = 'default';

/** How many models the list opens with. Claude alone reports a dozen, most of
 *  them pinned old versions, and a menu that long buries the three anyone
 *  actually picks between. */
const SHORTLIST = 3;

/**
 * The models worth opening with: the default, then FAMILY ALIASES, then the
 * rest in the agent's own order.
 *
 * An alias ("opus", "sonnet") tracks the newest model of its family and is what
 * someone choosing a model means; a versioned id ("claude-opus-4-6") is a pin,
 * and pins are what the list is full of. Having no digit in the id is exactly
 * that distinction, and it needs no table of model names to go stale — an agent
 * whose ids are all versioned (Codex, OpenCode) simply keeps its own order.
 *
 * The CHOSEN model is always in the list, however far down it really is: a
 * shortlist that hid what the chip says would read as a bug.
 */
function shortlist(models: ModelInfo[], chosen: ModelInfo | null): ModelInfo[] {
    const rank = (m: ModelInfo) => (m.isDefault ? 0 : /\d/.test(m.id) ? 2 : 1);
    const ordered = models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);
    const picked = ordered.slice(0, SHORTLIST).map(e => e.m);
    if (chosen && !picked.includes(chosen)) picked.push(chosen);
    // Back into the agent's own order, so the list does not reshuffle itself
    // when the user picks a different model.
    return models.filter(m => picked.includes(m));
}

export function ModelPicker({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    /** Reset every time the popover opens: the short list is the way in. */
    const [showAll, setShowAll] = useState(false);
    const config = configOf(state);
    const entry = state.models[config.agent];
    const models = entry?.models ?? [];
    const model = resolveModel(models, config.model);
    const effort = config.effort && model?.efforts.includes(config.effort) ? config.effort : model?.defaultEffort ?? null;
    // A model with levels but no default of its own (OpenCode's variants) gets
    // a "Default" stop meaning "none chosen" — without it the control was
    // hidden, since there was no value to put the thumb on.
    const effortLevels = !model ? [] : model.defaultEffort || !model.efforts.length ? model.efforts : [DEFAULT_EFFORT, ...model.efforts];

    // Not memoized: a dozen models sorted once per render of a popover the user
    // has open, and a manual memo here is one the React Compiler declines to
    // keep (it cannot prove `models` is not mutated later).
    const shown = showAll ? models : shortlist(models, model);

    const chipLabel = model
        ? model.label + (effort && model.efforts.length ? ` · ${effortLabel(effort)}` : '')
        : entry?.status === 'loading' ? 'Loading models…' : 'Default model';

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        void chatStore.ensureModels(config.agent);
        setShowAll(false);
        setAnchor(e.currentTarget);
    };

    // A model is one choice, so picking it is done (the effort slider is the
    // part that stays open while it is dragged); left open it sat over the
    // conversation until clicked away.
    const pickModel = (id: string) => {
        setAnchor(null);
        const next = models.find(m => m.id === id);
        // Keep the effort when the new model offers it; else its own default.
        const keep = config.effort && next?.efforts.includes(config.effort) ? config.effort : null;
        chatStore.setModel(id, keep);
    };

    return (
        <>
            <button
                type="button"
                className="agent-chip"
                aria-haspopup="menu"
                aria-expanded={anchor !== null}
                disabled={disabled}
                onClick={toggle}
                data-tooltip="Model and effort for the next message"
                data-tooltip-position="top"
            >
                <span className="agent-chip-label">{chipLabel}</span>
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            {anchor && (
                <Popover anchor={anchor} onClose={() => setAnchor(null)} theme={theme} label="Model" placement="above" className="agent-model-popover">
                    <div className="agent-popover-title">Model</div>
                    {entry?.status === 'error' && (
                        <div className="agent-popover-note">
                            Couldn't load the models. {entry.error}
                            <button type="button" className="agent-link" onClick={() => void chatStore.ensureModels(config.agent, true)}>Retry</button>
                        </div>
                    )}
                    {entry?.status === 'loading' && !models.length && <div className="agent-popover-note">Loading…</div>}
                    {shown.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={m.id === model?.id}
                            className="agent-popover-row"
                            onClick={() => pickModel(m.id)}
                        >
                            <span className="agent-popover-row-main">
                                <span className="agent-popover-row-title">{m.label}</span>
                                <span className="agent-popover-row-meta">
                                    {[m.isDefault ? 'Default' : null, m.images ? null : 'No images'].filter(Boolean).join(' · ') || m.id}
                                </span>
                            </span>
                            {m.id === model?.id && <Check size={14} className="agent-popover-check" aria-hidden="true" />}
                        </button>
                    ))}
                    {models.length > shown.length && (
                        <button type="button" className="agent-popover-more" onClick={() => setShowAll(true)}>
                            {`Show all ${models.length} models`}
                        </button>
                    )}
                    {effortLevels.length > 0 && (
                        <>
                            <div className="agent-popover-sep" role="separator" />
                            <EffortControl
                                levels={effortLevels}
                                value={effort ?? DEFAULT_EFFORT}
                                onChange={next => chatStore.setModel(config.model, next === DEFAULT_EFFORT ? null : next)}
                            />
                        </>
                    )}
                </Popover>
            )}
        </>
    );
}
