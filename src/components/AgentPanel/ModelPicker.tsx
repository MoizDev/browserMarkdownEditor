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

const DEFAULT_EFFORT = 'default';

const SHORTLIST = 3;

function shortlist(models: ModelInfo[], chosen: ModelInfo | null): ModelInfo[] {
    const rank = (m: ModelInfo) => (m.isDefault ? 0 : /\d/.test(m.id) ? 2 : 1);
    const ordered = models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);
    const picked = ordered.slice(0, SHORTLIST).map(e => e.m);
    if (chosen && !picked.includes(chosen)) picked.push(chosen);
    return models.filter(m => picked.includes(m));
}

export function ModelPicker({ state, theme, disabled }: { state: ChatStoreState; theme: Theme; disabled: boolean }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [showAll, setShowAll] = useState(false);
    const config = configOf(state);
    const entry = state.models[config.agent];
    const models = entry?.models ?? [];
    const model = resolveModel(models, config.model);
    const effort = config.effort && model?.efforts.includes(config.effort) ? config.effort : model?.defaultEffort ?? null;
    const effortLevels = !model ? [] : model.defaultEffort || !model.efforts.length ? model.efforts : [DEFAULT_EFFORT, ...model.efforts];

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

    const pickModel = (id: string) => {
        setAnchor(null);
        const next = models.find(m => m.id === id);
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
