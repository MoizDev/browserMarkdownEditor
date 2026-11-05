// What the model selector and its menus are built from: the chat's model and
// effort as they stand, which models a menu opens with, and how a model is
// named and described. Kept apart from ModelPicker.tsx so that file exports
// components only (Fast Refresh), and so a retry menu can list models the
// same way without importing the selector.

import type { ModelInfo } from '../../../shared/vaultAgentProtocol';
import { configOf, resolveModel } from './chatStore';
import type { ChatConfig, ChatStoreState, ModelsEntry } from './chatStore';

/** The effort stop for "the model's own default" (sent as no effort). */
export const DEFAULT_EFFORT = 'default';

/** The one-line reasons, by family. Only Claude's families have them;
 *  every other agent's rows go without rather than with a made-up line. */
const FAMILY_NOTES: Record<string, string> = {
    opus: 'Most capable, slower',
    sonnet: 'Balanced',
    haiku: 'Fastest',
};

/** "Default (recommended)" → "Default": the parenthesis is a description, and
 *  in the 300px selector it pushed the effort off the end. */
export function shortModelLabel(label: string): string {
    return label.replace(/\s*\([^)]*\)\s*$/, '') || label;
}

/** A FAMILY ALIAS ("opus", "sonnet") tracks the newest model of its family and
 *  is what someone choosing a model means; a versioned id ("claude-opus-4-6")
 *  is a pin. No digit in the id is exactly that distinction, with no table of
 *  model names to go stale. */
export function isAlias(m: ModelInfo): boolean {
    return !/\d/.test(m.id);
}

/** The row's one quiet line — never the raw id (an id as a subtitle was the
 *  old menu's most-cited wart). */
export function describeModel(m: ModelInfo, pinsExist: boolean): string | undefined {
    const parts: string[] = [];
    const paren = /\(([^)]+)\)\s*$/.exec(m.label)?.[1];
    if (paren) parts.push(paren.charAt(0).toUpperCase() + paren.slice(1));
    else if (isAlias(m) && FAMILY_NOTES[m.id.toLowerCase()]) parts.push(FAMILY_NOTES[m.id.toLowerCase()]);
    else if (pinsExist && !isAlias(m)) parts.push('Pinned version');
    if (!m.images) parts.push('No images');
    return parts.length ? parts.join(' · ') : undefined;
}

/**
 * Which models the menu opens with, and which wait behind "More models".
 *
 * An agent that reports family aliases (Claude) opens with the default and the
 * aliases — Default · Opus · Sonnet · Haiku — and its dozen pinned versions
 * wait. One whose ids are all versioned (Codex, OpenCode) opens with the first
 * three in its own order. The CHOSEN model is always shown: a short list that
 * hid what the selector says would read as a bug. Both lists keep the agent's
 * own order, so picking a model never reshuffles them.
 */
export function menuModels(models: ModelInfo[], chosen: ModelInfo | null): { first: ModelInfo[]; rest: ModelInfo[] } {
    const families = models.filter(m => m.isDefault || isAlias(m));
    let picked = families.length > 1 ? families : models.slice(0, 3);
    if (chosen && !picked.includes(chosen)) picked = [...picked, chosen];
    return { first: models.filter(m => picked.includes(m)), rest: models.filter(m => !picked.includes(m)) };
}

export interface ModelChoice {
    config: ChatConfig;
    entry: ModelsEntry | undefined;
    models: ModelInfo[];
    model: ModelInfo | null;
    /** The effort in force: the chat's when the model offers it, else the model's default. */
    effort: string | null;
    /** The Effort control's stops ([] = none). A model with levels but no
     *  default of its own (OpenCode's variants) gets a "Default" stop meaning
     *  "none chosen" — without it there was no value to put the thumb on. */
    effortLevels: string[];
}

export function modelChoice(state: ChatStoreState): ModelChoice {
    const config = configOf(state);
    const entry = state.models[config.agent];
    const models = entry?.models ?? [];
    const model = resolveModel(models, config.model);
    const effort = config.effort && model?.efforts.includes(config.effort) ? config.effort : model?.defaultEffort ?? null;
    const effortLevels = !model ? [] : model.defaultEffort || !model.efforts.length ? model.efforts : [DEFAULT_EFFORT, ...model.efforts];
    return { config, entry, models, model, effort, effortLevels };
}
