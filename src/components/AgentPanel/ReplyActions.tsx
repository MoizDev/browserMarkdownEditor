// The row under a finished reply: Copy · "Retry ⌄" · the
// model's name at the right, in the quietest ink. Visible only on hover (or
// focus) — except under the LATEST reply, where it is what the reader reaches
// for next.
//
// Retry re-runs the turn as a new version of the message that asked it
// (chatStore.retry), with the model picked from the composer's own rows
// (ModelPicker's ModelRows over modelChoice.ts): families first, each with its
// one-line description, never a raw id under a name — one module, so the two
// menus can never disagree about which models open the list or how they read.
// Its Effort is the composer's control (ModelPicker's EffortSection) holding a
// choice of its own: like the model picked here, it is for that one retry —
// the chat goes on with its own model and effort. It opens on the chat's.

import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import type { Theme } from '../../types';
import { copyText } from '../../utils/clipboard';
import { chatStore, configOf, resolveModel } from './chatStore';
import type { ChatStoreState } from './chatStore';
import { useChatState } from './useAgentChat';
import { Popover } from './Popover';
import { EffortSection, ModelRows } from './ModelPicker';
import { modelChoice, shortModelLabel } from './modelChoice';
import { IconButton } from './ui/IconButton';
import { MenuSection, MenuSeparator } from './ui/MenuRow';
import { Check, ChevronDown, Copy, RotateCcw } from './ui/icons';

/** The name to print under a reply: the model the turn ran with when the item
 *  knows it, else the chat's configured one. A string, so the subscription
 *  below re-renders the row only when the NAME changes, not on every token. */
function modelLabelOf(state: ChatStoreState, modelId: string | null): string {
    const config = configOf(state);
    const models = state.models[config.agent]?.models;
    // A model the list no longer offers is still named — by its id, the one
    // place an id shows, since a blank would claim the configured model ran.
    if (modelId) {
        const ran = models?.find(m => m.id === modelId);
        return ran ? shortModelLabel(ran.label) : modelId;
    }
    const configured = resolveModel(models, config.model);
    return configured ? shortModelLabel(configured.label) : '';
}

function RetryMenu({ anchor, theme, userNodeId, modelId, onClose }: {
    anchor: HTMLElement; theme: Theme; userNodeId: string; modelId: string | null; onClose: () => void;
}) {
    const state = useChatState();
    const config = configOf(state);
    const entry = state.models[config.agent];
    const models = entry?.models ?? [];
    const used = (modelId && models.find(m => m.id === modelId)) || resolveModel(models, config.model);
    const choice = modelChoice(state);
    // undefined = not touched: the retry runs at the chat's effort (or the
    // picked model's default where it has no such level).
    const [effort, setEffort] = useState<string | null | undefined>(undefined);
    // Near the bottom of the window (the latest reply sits just above the
    // composer) the list opens upwards, as the composer's own menus do.
    const [placement] = useState<'above' | 'below'>(() =>
        anchor.getBoundingClientRect().bottom > window.innerHeight - 280 ? 'above' : 'below');
    return (
        <Popover
            anchor={anchor}
            onClose={onClose}
            theme={theme}
            label="Retry with a model"
            role="dialog"
            placement={placement}
            className="va-retry-menu"
        >
            <MenuSection label="Model" />
            {entry?.status === 'loading' && !models.length && <div className="agent-pop-hint">Loading models…</div>}
            {entry?.status === 'error' && !models.length && <div className="agent-pop-hint">Couldn't load the models.</div>}
            <ModelRows models={models} chosen={used} onPick={m => { onClose(); chatStore.retry(userNodeId, m.id, effort); }} />
            {choice.effortLevels.length > 0 && <MenuSeparator />}
            <EffortSection choice={choice} effort={effort === undefined ? choice.effort : effort} onChange={setEffort} />
        </Popover>
    );
}

export interface ReplyActionsProps {
    /** Everything the turn said, for Copy. */
    text: string;
    /** The user message the turn answers (retry re-runs it); null for a turn
     *  with nothing above it. */
    userNodeId: string | null;
    /** The model the turn ran with, when the item records it. */
    modelId: string | null;
    /** Under the newest reply: always visible. */
    latest: boolean;
    /** A run is live somewhere: retry would start a second one. */
    busy: boolean;
    theme: Theme;
}

function ReplyActionsImpl({ text, userNodeId, modelId, latest, busy, theme }: ReplyActionsProps) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const label = useSyncExternalStore(chatStore.subscribe, () => modelLabelOf(chatStore.getState(), modelId));

    const copy = async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        if (anchor) { setAnchor(null); return; }
        void chatStore.ensureModels(configOf(chatStore.getState()).agent);
        setAnchor(e.currentTarget);
    };

    const canRetry = !!userNodeId && !busy;
    return (
        <div className={'va-acts' + (latest || anchor ? ' is-shown' : '')}>
            <IconButton size="26" label={copied ? 'Copied' : 'Copy reply'} tooltip={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />}
            </IconButton>
            {userNodeId && (
                <button
                    type="button"
                    className="va-acts-retry"
                    aria-haspopup="dialog"
                    aria-expanded={anchor !== null}
                    aria-disabled={canRetry ? undefined : true}
                    data-tooltip={canRetry ? 'Retry with a model' : 'Wait for the reply to finish'}
                    onClick={canRetry ? toggle : undefined}
                >
                    <RotateCcw aria-hidden="true" />
                    Retry
                    <ChevronDown className="va-acts-chev" aria-hidden="true" />
                </button>
            )}
            {label && <span className="va-acts-model">{label}</span>}
            {anchor && userNodeId && (
                <RetryMenu anchor={anchor} theme={theme} userNodeId={userNodeId} modelId={modelId} onClose={() => setAnchor(null)} />
            )}
        </div>
    );
}

export const ReplyActions = memo(ReplyActionsImpl);
