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
import { effortLabel } from './useAgentChat';

/** The effort stop for "the model's own default" (sent as no effort). */
const DEFAULT_EFFORT = 'default';

export function ModelPicker({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const config = configOf(state);
    const entry = state.models[config.agent];
    const models = entry?.models ?? [];
    const model = resolveModel(models, config.model);
    const effort = config.effort && model?.efforts.includes(config.effort) ? config.effort : model?.defaultEffort ?? null;
    // A model with levels but no default of its own (OpenCode's variants) gets
    // a "Default" stop meaning "none chosen" — without it the control was
    // hidden, since there was no value to put the thumb on.
    const effortLevels = !model ? [] : model.defaultEffort || !model.efforts.length ? model.efforts : [DEFAULT_EFFORT, ...model.efforts];

    const chipLabel = model
        ? model.label + (effort && model.efforts.length ? ` · ${effortLabel(effort)}` : '')
        : entry?.status === 'loading' ? 'Loading models…' : 'Default model';

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        void chatStore.ensureModels(config.agent);
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
                    {models.map(m => (
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
